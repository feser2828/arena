import { pub } from "./chain.js";
import { config } from "./config.js";
import { arenaAbi } from "./abis.js";

export type Venue = "curve" | "dex";

export async function currentVenue(): Promise<Venue> {
    const params = await pub.readContract({
    address: config.launch,
    abi: arenaAbi,
    functionName: "tokenParams",
    args: [config.tokenId],
  });
  return params[3] ? "dex" : "curve";
}