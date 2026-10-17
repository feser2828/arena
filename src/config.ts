import "dotenv/config";
import { getAddress, type Hex } from "viem";

const req = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};

export const config = {
  botToken: req("BOT_TOKEN"),
      masterKey: (() => {
    const k = req("MASTER_KEY").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(k)) throw new Error("MASTER_KEY must be exactly 64 hex characters");
    return Buffer.from(k, "hex");
  })(),
  rpc: req("AVAX_RPC"),
  token: getAddress(req("TOKEN_ADDRESS")),
  launch: getAddress(req("ARENA_LAUNCH_CONTRACT")),
  tokenId: BigInt(req("ARENA_TOKEN_ID")),
  router: getAddress(req("DEX_ROUTER")),
  slippageBps: BigInt(process.env.SLIPPAGE_BPS ?? "1000"),
  wavax: getAddress("0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7"),
};