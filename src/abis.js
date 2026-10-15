export const tokenAbi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];

export const escrowAbi = [
  { type: "function", name: "lock", stateMutability: "nonpayable", inputs: [{ name: "sagaId", type: "bytes32" }, { name: "owner", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "sagaId", type: "bytes32" }, { name: "vault", type: "address" }], outputs: [] },
  { type: "function", name: "refund", stateMutability: "nonpayable", inputs: [{ name: "sagaId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "entries", stateMutability: "view", inputs: [{ name: "sagaId", type: "bytes32" }], outputs: [{ name: "owner", type: "address" }, { name: "amount", type: "uint256" }, { name: "status", type: "uint8" }] },
];

export const vaultAbi = [
  { type: "function", name: "setReject", stateMutability: "nonpayable", inputs: [{ name: "sagaId", type: "bytes32" }, { name: "reject", type: "bool" }], outputs: [] },
  { type: "function", name: "creditOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "rejectSaga", stateMutability: "view", inputs: [{ name: "sagaId", type: "bytes32" }], outputs: [{ type: "bool" }] },
];
