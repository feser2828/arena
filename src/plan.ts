import { parseEther } from "viem";
import { pub } from "./chain.js";
import { config } from "./config.js";
import { erc20Abi } from "./abis.js";
import { listWallets } from "./db.js";
import { currentVenue } from "./venue.js";
import { avaxUsd } from "./portfolio.js";
import { buyAll, sellAll } from "./trade.js";
import { GAS_RESERVE, fmtAvax, fmtTok, tokensForUsd } from "./checks.js";

export type Order =
  | { side: "buy"; usd?: number; avax?: number }
  | { side: "sell"; usd?: number; pct?: number };

// "25", "$25", "25 usd" = dollars. "0.5 avax" = AVAX (buy only). "50%" = percent (sell only).
export function parseAmount(side: "buy" | "sell", raw: string): Order | null {
  const t = String(raw).trim().toLowerCase().replace(/,/g, "");
  let m = t.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (m) {
    const p = Number(m[1]);
    return side === "sell" && Number.isInteger(p) && p >= 1 && p <= 100 ? { side, pct: p } : null;
  }
  m = t.match(/^(\d+(?:\.\d+)?)\s*avax$/);
  if (m) {
    const v = Number(m[1]);
    return side === "buy" && v > 0 ? { side, avax: v } : null;
  }
  m = t.match(/^\$?\s*(\d+(?:\.\d+)?)\s*(?:usd|dollars?)?$/);
  if (m) {
    const v = Number(m[1]);
    return v > 0 ? { side, usd: v } : null;
  }
  return null;
}

export async function previewOrder(uid: number, o: Order): Promise<{ text: string; ready: boolean }> {
  const list = listWallets(uid);
  if (list.length === 0) throw new Error("No wallets yet. Tap Wallets to create or import one.");
  const price = await avaxUsd();
  if (o.usd !== undefined && price <= 0) throw new Error("Could not read the AVAX price. Try again in a moment.");
  const venue = await currentVenue().catch(() => null);
  if (!venue) throw new Error("Cannot read the token state from the Arena launch contract. Check ARENA_LAUNCH_CONTRACT in .env.");

  const reserve = parseEther(GAS_RESERVE);
  const lines: string[] = [];
  let ready = false;

  if (o.side === "buy") {
    const avax = o.avax ?? (o.usd as number) / price;
    if (!(avax >= 0.000001)) throw new Error("That amount is too small.");
    const avaxStr = avax.toFixed(6);
    const need = parseEther(avaxStr) + reserve;
    lines.push(
      o.usd !== undefined
        ? `Buy about $${o.usd.toFixed(2)} (${avaxStr} AVAX at $${price.toFixed(2)} per AVAX) on each wallet`
        : `Buy ${avaxStr} AVAX worth on each wallet`,
      `Venue: ${venue}`,
      "",
    );
    for (const w of list) {
      const have = await pub.getBalance({ address: w.address as `0x${string}` });
      if (have >= need) {
        ready = true;
        lines.push(`${w.label}  ready, balance ${fmtAvax(have)} AVAX`);
      } else {
        lines.push(`${w.label}  not enough AVAX: needs ${fmtAvax(need)} including gas, has ${fmtAvax(have)}. Will be skipped.`);
      }
    }
    return { text: lines.join("\n"), ready };
  }

  let perWallet: bigint | null = null;
  if (o.usd !== undefined) {
    if (venue === "curve") {
      throw new Error("Selling by dollar amount is not available while the token is on the Arena curve. Sell by percentage instead, for example 50%.");
    }
    perWallet = await tokensForUsd(o.usd, price).catch(() => {
      throw new Error("Could not get a price quote for that amount. The pool may not have enough liquidity.");
    });
    lines.push(`Sell about $${o.usd.toFixed(2)} (${fmtTok(perWallet)} tokens) on each wallet`);
  } else {
    lines.push(`Sell ${o.pct}% of the token balance on each wallet`);
  }
  lines.push(`Venue: ${venue}`, "");

  for (const w of list) {
    const addr = w.address as `0x${string}`;
    const [bal, gas] = await Promise.all([
      pub.readContract({ address: config.token, abi: erc20Abi, functionName: "balanceOf", args: [addr] }),
      pub.getBalance({ address: addr }),
    ]);
    const amount = perWallet ?? (bal * BigInt(o.pct as number)) / 100n;
    if (bal === 0n) {
      lines.push(`${w.label}  no tokens. Will be skipped.`);
    } else if (perWallet !== null && bal < perWallet) {
      lines.push(`${w.label}  not enough tokens: needs ${fmtTok(perWallet)}, has ${fmtTok(bal)}. Will be skipped.`);
    } else if (gas < reserve) {
      lines.push(`${w.label}  not enough AVAX for gas: needs ${fmtAvax(reserve)}, has ${fmtAvax(gas)}. Will be skipped.`);
    } else {
      ready = true;
      lines.push(`${w.label}  ready, sells ${fmtTok(amount)} of ${fmtTok(bal)} tokens`);
    }
  }
  return { text: lines.join("\n"), ready };
}

export async function runOrder(uid: number, o: Order) {
  const price = o.usd !== undefined ? await avaxUsd() : 0;
  if (o.usd !== undefined && price <= 0) throw new Error("Could not read the AVAX price. Try again in a moment.");
  if (o.side === "buy") {
    const avax = o.avax ?? (o.usd as number) / price;
    return buyAll(uid, avax.toFixed(6));
  }
  if (o.usd !== undefined) {
    const tokens = await tokensForUsd(o.usd, price);
    return sellAll(uid, 0, tokens);
  }
  return sellAll(uid, o.pct as number);
}