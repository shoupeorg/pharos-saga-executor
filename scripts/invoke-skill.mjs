const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.join("=") || true];
}));
const base = String(args.url || "https://pharos-saga-executor.shoupeorg.workers.dev").replace(/\/$/, "");
const mode = args.mode || "success";
const amount = args.amount || "1";
const request = async (endpoint, body) => {
  const response = await fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
};

let result = args.resume
  ? await request(`${base}/api/sagas/${encodeURIComponent(args.resume)}/resume`, {})
  : await request(`${base}/api/sagas`, { mode, amount });
const states = [result.saga.state];
for (let step = 0; step < 8 && !["COMPLETED", "RECOVERED", "ERROR", "RECOVERY_REQUIRED"].includes(result.saga.state); step += 1) {
  result = await request(`${base}/api/sagas/${encodeURIComponent(result.saga.id)}/resume`, {});
  states.push(result.saga.state);
}
console.log(JSON.stringify({ ...result, invocationStates: states }, null, 2));
if (!["COMPLETED", "RECOVERED"].includes(result.saga.state)) process.exitCode = 1;
