import { parseEther } from "viem";
import { pub, type Wallet } from "./chain.js";
import { config } from "./config.js";
import { arenaAbi } from "./abis.js";

export async function curveBuy(w: Wallet, avax: string) {
  const value = parseEther(avax);
  const budget = (value * (10_000n - config.slippageBps)) / 10_000n;
  const cost = (n: bigint) =>
    pub.readContract({
      address: config.launch, abi: arenaAbi, functionName: "calculateCostWithFees", args: [n, config.tokenId],
    }).catch(() => budget + 1n);
  let lo = 0n, hi = 1n;
  while ((await cost(hi)) <= budget && hi < 10n ** 12n) { lo = hi; hi *= 2n; }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await cost(mid)) <= budget) lo = mid; else hi = mid;
  }
  if (lo === 0n) throw new Error("Amount too small to buy one whole token.");
  return w.client.writeContract({
    address: config.launch, abi: arenaAbi, functionName: "buyAndCreateLpIfPossible",
    args: [lo * 10n ** 18n, config.tokenId], value,
  });
}

export async function curveSell(w: Wallet, amount: bigint) {
  const whole = amount - (amount % 10n ** 18n);
  if (whole === 0n) throw new Error("Less than one whole token. The curve only sells whole tokens.");
  return w.client.writeContract({
    address: config.launch, abi: arenaAbi, functionName: "sell", args: [whole, config.tokenId],
  });
}