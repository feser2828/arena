import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

export const routerAbi = parseAbi([
  "function swapExactAVAXForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable",
  "function swapExactTokensForAVAXSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[])",
]);

// VERIFY EVERY LINE BELOW against the real ABI on Snowtrace (Contract > Write as Proxy / Read as Proxy).
// I have not seen the actual signatures. Only this file and curve.ts should need changing.
export const launchAbi = parseAbi([
  "function buyAndCreateLpIfPossible(uint256 tokenId, uint256 amount) payable",
  "function sell(uint256 tokenId, uint256 amount)",
  "function lpDeployed(uint256 tokenId) view returns (bool)",
]);

export const arenaAbi = [
  { type: "function", name: "buyAndCreateLpIfPossible", stateMutability: "payable",
    inputs: [{ name: "amount", type: "uint256" }, { name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "sell", stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }, { name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "calculateCostWithFees", stateMutability: "view",
    inputs: [{ name: "amount", type: "uint256" }, { name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "tokenParams", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "curveScaler", type: "uint128" }, { name: "a", type: "uint16" }, { name: "b", type: "uint8" },
      { name: "lpDeployed", type: "bool" }, { name: "f1", type: "uint8" }, { name: "f2", type: "uint8" },
      { name: "f3", type: "uint8" }, { name: "creator", type: "address" },
      { name: "addr2", type: "address" }, { name: "tokenContract", type: "address" },
    ] },
] as const;