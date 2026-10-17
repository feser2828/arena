import { parseEther } from "viem";
import { pub, type Wallet } from "./chain.js";
import { config } from "./config.js";
import { routerAbi } from "./abis.js";

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 120);

export async function dexBuy(w: Wallet, avax: string) {
  const value = parseEther(avax);
  const path = [config.wavax, config.token] as const;
  const [, out] = await pub.readContract({
    address: config.router, abi: routerAbi, functionName: "getAmountsOut", args: [value, path],
  });
  const min = (out * (10_000n - config.slippageBps)) / 10_000n;
  return w.client.writeContract({
    address: config.router, abi: routerAbi,
    functionName: "swapExactAVAXForTokensSupportingFeeOnTransferTokens",
    args: [min, path, w.account.address, deadline()], value,
  });
}

export async function dexSell(w: Wallet, amount: bigint) {
  const path = [config.token, config.wavax] as const;
  const [, out] = await pub.readContract({
    address: config.router, abi: routerAbi, functionName: "getAmountsOut", args: [amount, path],
  });
  const min = (out * (10_000n - config.slippageBps)) / 10_000n;
  return w.client.writeContract({
    address: config.router, abi: routerAbi,
    functionName: "swapExactTokensForAVAXSupportingFeeOnTransferTokens",
    args: [amount, min, path, w.account.address, deadline()],
  });
}