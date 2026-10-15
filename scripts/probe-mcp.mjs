import { createAtlanticMcp } from "../src/mcp-runtime.js";

const mcp = await createAtlanticMcp("https://atlantic.dplabs-internal.com");
try {
  const tools = await mcp.listTools();
  const chain = await mcp.call("get_chain_info");
  const gas = await mcp.call("get_gas_price");
  console.log(JSON.stringify({ tools: tools.map(({ name, inputSchema }) => ({ name, inputSchema })), chain, gas }, null, 2));
} finally {
  await mcp.close();
}
