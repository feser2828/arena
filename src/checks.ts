import { formatUnits, parseAbi, parseEther, type Address } from "viem";
import { pub, type Wallet } from "./chain.js";
import { config } from "./config.js";
import { erc20Abi } from "./abis.js";

// AVAX kept in every wallet to pay gas. Override with GAS_RESERVE_AVAX in .env.
export const GAS_RESERVE = process.env.GAS_RESERVE_AVAX ?? "0.02";

const quoteAbi = parseAbi(["function getAmountsIn(uint256 amountOut,address[] path) view returns (uint256[])"]);

const fmt = (n: bigint) => Number(formatUnits(n, 18)).toLocaleString("en-US", { maximumFractionDigits: 4 });
export const fmtAvax = fmt;
export const fmtTok = fmt;

export async function requireAvax(w: Wallet, avax: string) {
  const need = parseEther(avax) + parseEther(GAS_RESERVE);
  const have = await pub.getBalance({ address: w.account.address });
  if (have < need) throw new Error(`Not enough AVAX: needs ${fmtAvax(need)} including gas, has ${fmtAvax(have)}`);
}

export async function requireGas(w: Wallet) {
  const need = parseEther(GAS_RESERVE);
  const have = await pub.getBalance({ address: w.account.address });
  if (have < need) throw new Error(`Not enough AVAX for gas: needs ${fmtAvax(need)}, has ${fmtAvax(have)}`);
}

// Approves exactly what is about to be sold, only when the current allowance is too low.
export async function ensureAllowance(w: Wallet, spender: Address, amount: bigint) {
  const have = await pub.readContract({
    address: config.token, abi: erc20Abi, functionName: "allowance", args: [w.account.address, spender],
  });
  if (have >= amount) return;
  const hash = await w.client.writeContract({
    address: config.token, abi: erc20Abi, functionName: "approve", args: [spender, amount],
  });
  await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
}

// Tokens needed to receive about `usd` worth of AVAX from the DEX pool.
export async function tokensForUsd(usd: number, avaxPrice: number): Promise<bigint> {
  const avaxOut = parseEther((usd / avaxPrice).toFixed(12));
  const amounts = await pub.readContract({
    address: config.router, abi: quoteAbi, functionName: "getAmountsIn",
    args: [avaxOut, [config.token, config.wavax]],
  });
  return amounts[0];
}