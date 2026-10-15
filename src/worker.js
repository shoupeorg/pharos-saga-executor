import { getAddress } from "viem";
import { tokenAbi, escrowAbi, vaultAbi } from "./abis.js";
import { AtlanticChain, parseAmount } from "./chain.js";
import { executeDepositStep, executeSaga, FINAL_STATES, newSaga, RECEIPT_FAILURE_POLICY, RESUMABLE_STATES } from "./saga.js";
import { D1SagaStore } from "./store.js";
import { ATLANTIC_CHAIN_ID, OFFICIAL_MCP_SOURCE } from "./mcp-runtime.js";

const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function contracts(env) {
  const token = getAddress(env.DEMO_TOKEN_ADDRESS);
  const escrow = getAddress(env.SAGA_ESCROW_ADDRESS);
  const vault = getAddress(env.TEST_VAULT_ADDRESS);
  return { token, escrow, vault, tokenAbi, escrowAbi, vaultAbi };
}

function safeRecord(record) {
  return { ...record, retryPolicy: record.retryPolicy, signer: "server-side dedicated Atlantic testnet signer" };
}

async function buildContext(env) {
  if (Number(env.CHAIN_ID) !== ATLANTIC_CHAIN_ID) throw new Error("Worker is not configured for Atlantic Testnet");
  const chain = new AtlanticChain({ rpcUrl: env.ATLANTIC_RPC_URL, privateKey: env.EXECUTOR_PRIVATE_KEY });
  return { chain, store: new D1SagaStore(env.DB), contracts: contracts(env) };
}

async function startSaga(request, env) {
  const actor = request.headers.get("CF-Connecting-IP") || "unknown";
  const { chain, store, contracts: deployed } = await buildContext(env);
  const rateLimit = Number(env.RATE_LIMIT || "20");
  if (!(await store.consumeRateLimit(actor, Date.now(), 3_600_000, rateLimit))) return json({ error: `Demo rate limit reached: ${rateLimit} saga steps per hour per client.` }, 429);
  const body = await request.json();
  if (!["success", "failure", "failure-broadcast"].includes(body.mode)) return json({ error: "mode must be success, failure, or failure-broadcast" }, 400);
  const amountText = String(body.amount ?? "1");
  const metadata = await chain.session(async (mcp) => ({
    decimals: Number(await chain.read(mcp, deployed.token, tokenAbi, "decimals")),
    symbol: await chain.read(mcp, deployed.token, tokenAbi, "symbol"),
  }));
  const amountRaw = parseAmount(amountText, metadata.decimals, env.MAX_AMOUNT || "10");
  if (body.mode === "failure-broadcast" && amountRaw > RECEIPT_FAILURE_POLICY.maximumAmountRaw) return json({ error: "Receipt-verified forced failure is limited to 1 SGT" }, 400);
  const id = `saga-${body.mode}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const record = newSaga({
    id, mode: body.mode, owner: chain.account.address, amount: amountText, amountRaw: amountRaw.toString(),
    chainId: ATLANTIC_CHAIN_ID,
    contracts: { token: deployed.token, escrow: deployed.escrow, vault: deployed.vault, symbol: metadata.symbol, decimals: metadata.decimals },
  });
  await store.create(record);
  return runLocked({ store, chain, contracts: deployed, record });
}

async function runLocked({ store, chain, contracts: deployed, record }) {
  const lock = crypto.randomUUID();
  if (!(await store.acquire(record.id, lock))) return json({ error: "This saga is already executing", saga: safeRecord(await store.get(record.id)) }, 409);
  try {
    const latest = await store.get(record.id);
    if (FINAL_STATES.has(latest.state)) return json({ saga: safeRecord(latest), resumed: false });
    if (!RESUMABLE_STATES.has(latest.state)) return json({ error: `Saga state ${latest.state} is not automatically resumable`, saga: safeRecord(latest) }, 409);
    const pendingFailedDeposit = latest.state === "RECOVERY_REQUIRED" && latest.transactions?.deposit?.hash && !latest.compensation?.required;
    const operation = ["LOCKED", "DEPOSIT_PENDING"].includes(latest.state) || pendingFailedDeposit ? executeDepositStep : executeSaga;
    const result = await operation({ store, record: latest, chain, contracts: deployed });
    return json({ saga: safeRecord(result), resumed: latest.state !== "CREATED" });
  } finally {
    await store.release(record.id, lock);
  }
}

async function resumeSaga(request, env, id) {
  const actor = request.headers.get("CF-Connecting-IP") || "unknown";
  const context = await buildContext(env);
  const rateLimit = Number(env.RATE_LIMIT || "20");
  if (!(await context.store.consumeRateLimit(actor, Date.now(), 3_600_000, rateLimit))) return json({ error: `Demo rate limit reached: ${rateLimit} saga steps per hour per client.` }, 429);
  const record = await context.store.get(id);
  if (!record) return json({ error: "Saga not found" }, 404);
  return runLocked({ ...context, record });
}

async function configResponse(env) {
  const { chain, contracts: deployed } = await buildContext(env);
  const live = await chain.session(async (mcp, info) => {
    const tools = await mcp.listTools();
    const [decimals, symbol] = await Promise.all([
      chain.read(mcp, deployed.token, tokenAbi, "decimals"),
      chain.read(mcp, deployed.token, tokenAbi, "symbol"),
    ]);
    return { block: info.latestBlock, tools: tools.map((t) => t.name), decimals: Number(decimals), symbol };
  });
  return {
    network: "Pharos Atlantic Testnet", chainId: ATLANTIC_CHAIN_ID, explorer: env.EXPLORER_URL,
    owner: chain.account.address,
    contracts: { token: deployed.token, escrow: deployed.escrow, vault: deployed.vault },
    token: { symbol: live.symbol, decimals: live.decimals },
    latestBlock: live.block,
    mcp: { implementation: OFFICIAL_MCP_SOURCE, transport: "in-memory MCP client/server", upstream: env.ATLANTIC_RPC_URL, tools: live.tools },
    limits: { maxAmount: env.MAX_AMOUNT || "10", receiptVerifiedFailureMaxAmount: "1", receiptVerifiedFailureGasLimit: RECEIPT_FAILURE_POLICY.gasLimit.toString(), sagaStepsPerHourPerClient: Number(env.RATE_LIMIT || "20") },
    notices: ["TESTNET ONLY", "VALUELESS TEST TOKEN", "NO USER WALLET OR PRIVATE KEY REQUIRED", "FIRE/RECOVERY ACTIONS ARE REAL ATLANTIC TESTNET TRANSACTIONS"],
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/signer-check" && request.method === "GET") {
        const chain = new AtlanticChain({ rpcUrl: env.ATLANTIC_RPC_URL, privateKey: env.EXECUTOR_PRIVATE_KEY });
        return json({ address: chain.account.address, source: "Cloudflare Worker secret EXECUTOR_PRIVATE_KEY", secretExposed: false });
      }
      if (url.pathname === "/api/config" && request.method === "GET") return json(await configResponse(env));
      if (url.pathname === "/api/sagas" && request.method === "GET") {
        const { store } = await buildContext(env);
        return json({ sagas: (await store.list(30)).map(safeRecord) });
      }
      if (url.pathname === "/api/sagas" && request.method === "POST") return startSaga(request, env);
      const detail = url.pathname.match(/^\/api\/sagas\/([^/]+)$/);
      if (detail && request.method === "GET") {
        const { store } = await buildContext(env);
        const id = decodeURIComponent(detail[1]);
        const record = await store.get(id);
        if (!record) return json({ error: "Saga not found" }, 404);
        return json({ saga: safeRecord({ ...record, logs: await store.logs(id) }) });
      }
      const resume = url.pathname.match(/^\/api\/sagas\/([^/]+)\/resume$/);
      if (resume && request.method === "POST") return resumeSaga(request, env, decodeURIComponent(resume[1]));
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error.message, state: "ERROR / NO ACTION" }, 500);
    }
  },
};
