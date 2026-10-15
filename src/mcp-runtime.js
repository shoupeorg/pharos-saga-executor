import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPharosServer } from "./official-pharos-mcp/server.js";

export const OFFICIAL_MCP_SOURCE = "https://github.com/PharosNetwork/pharos-mcp";
export const ATLANTIC_CHAIN_ID = 688689;

function parseToolResult(response) {
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text result");
  const value = JSON.parse(text);
  if (response.isError || value?.error) {
    const error = new Error(value?.error?.message || "MCP tool failed");
    error.code = value?.error?.code;
    error.data = value?.error?.data;
    throw error;
  }
  return value;
}

export async function createAtlanticMcp(rpcUrl) {
  const server = createPharosServer({
    rpcUrl,
    chainId: ATLANTIC_CHAIN_ID,
    nativeSymbol: "PHRS",
    transport: "stdio",
    host: "127.0.0.1",
    port: 0,
    authToken: undefined,
    enableSendRawTransaction: true,
    rateLimitPerMinute: 0,
    trustProxy: false,
    maxSessions: 0,
    sessionTimeoutMinutes: 30,
  });
  const client = new Client({ name: "pharos-saga-executor", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    listTools: async () => (await client.listTools()).tools,
    call: async (name, args = {}) => parseToolResult(await client.callTool({ name, arguments: args })),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export async function withAtlanticMcp(rpcUrl, operation) {
  const mcp = await createAtlanticMcp(rpcUrl);
  try {
    return await operation(mcp);
  } finally {
    await mcp.close();
  }
}
