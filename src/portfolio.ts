import { formatUnits, parseAbi, type Address } from "viem";
import { pub } from "./chain.js";
import { config } from "./config.js";
import { routerAbi } from "./abis.js";
import { currentVenue } from "./venue.js";
import { listWallets } from "./db.js";

const AVAX_USD_FEED = "0x0a77230d17318075983913bc2145db16c7366156" as const;
const UNISWAP_V2_ROUTER = "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24" as const;
const MAX_TOKEN_LINES = 12;

const metaAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);

// Order matters: first router that returns a quote wins.
const ROUTERS = [
  { addr: UNISWAP_V2_ROUTER as Address, name: "Uniswap" },
  { addr: config.router.toLowerCase() as Address, name: "Arena pool" },
].filter((r, i, a) => a.findIndex((x) => x.addr === r.addr) === i);

let priceCache = { usd: 0, at: 0 };
export async function avaxUsd(): Promise<number> {
  if (priceCache.usd > 0 && Date.now() - priceCache.at < 30_000) return priceCache.usd;
  try {
    const r = await pub.readContract({ address: AVAX_USD_FEED, abi: feedAbi, functionName: "latestRoundData" });
    const usd = Number(r[1]) / 1e8;
    if (usd > 0) priceCache = { usd, at: Date.now() };
    return usd;
  } catch {
    return 0;
  }
}

const tokenCache = new Map<string, { at: number; list: Address[] }>();
async function discoverTokens(owner: Address): Promise<Address[]> {
  const hit = tokenCache.get(owner);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.list;
  const set = new Set<string>([config.token.toLowerCase()]);
  let ok = false;
  try {
    const url = `https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api?module=account&action=tokentx&address=${owner}&page=1&offset=1000&sort=desc`;
    const json: any = await (await fetch(url)).json();
    if (Array.isArray(json.result)) {
      for (const t of json.result) set.add(String(t.contractAddress).toLowerCase());
      ok = true;
    } else if (String(json.message).toLowerCase().includes("no transactions")) {
      ok = true;
    }
  } catch {}
  const list = [...set].slice(0, 150) as Address[];
  if (ok) tokenCache.set(owner, { at: Date.now(), list });
  return list;
}

const amt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
const short = (a: string) => `${a.slice(0, 6)}..${a.slice(-4)}`;

export async function walletSummary(label: string, address: string): Promise<string> {
  const owner = address as Address;
  const [price, avaxBal, tokens, venue] = await Promise.all([
    avaxUsd(),
    pub.getBalance({ address: owner }),
    discoverTokens(owner),
    currentVenue().catch(() => "unknown"),
  ]);

  const calls = tokens.flatMap((t) => [
    { address: t, abi: metaAbi, functionName: "balanceOf", args: [owner] },
    { address: t, abi: metaAbi, functionName: "decimals" },
    { address: t, abi: metaAbi, functionName: "symbol" },
  ]);
  const res: any[] = await pub.multicall({ contracts: calls as any, allowFailure: true });

  const held: { token: Address; amount: bigint; dec: number; symbol: string }[] = [];
  tokens.forEach((t, i) => {
    const bal = res[i * 3], dec = res[i * 3 + 1], sym = res[i * 3 + 2];
    if (!bal || bal.status !== "success" || bal.result === 0n) return;
    held.push({
      token: t,
      amount: bal.result as bigint,
      dec: dec?.status === "success" ? Number(dec.result) : 18,
      symbol: sym?.status === "success" ? String(sym.result).slice(0, 10) : "?",
    });
  });

  const priced = new Map<number, { avax: number; src: string }>();
  held.forEach((h, i) => {
    if (h.token.toLowerCase() === config.wavax.toLowerCase()) {
      priced.set(i, { avax: Number(formatUnits(h.amount, 18)), src: "WAVAX" });
    }
  });
  for (const r of ROUTERS) {
    const todo = held.map((_, i) => i).filter((i) => !priced.has(i));
    if (todo.length === 0) break;
    const out: any[] = await pub
      .multicall({
        contracts: todo.map((i) => ({
          address: r.addr, abi: routerAbi, functionName: "getAmountsOut",
          args: [held[i].amount, [held[i].token, config.wavax]],
        })) as any,
        allowFailure: true,
      })
      .catch(() => []);
    out.forEach((o, k) => {
      if (o.status === "success" && o.result.length === 2) {
        priced.set(todo[k], { avax: Number(formatUnits(o.result[1], 18)), src: r.name });
      }
    });
  }

  const usd = (avax: number) => (price > 0 ? ` ($${avax * price >= 0.01 ? (avax * price).toFixed(2) : "<0.01"})` : "");
  const avaxAmt = Number(formatUnits(avaxBal, 18));
  const lines = [`${label}  ${short(address)}`, `AVAX  ${amt(avaxAmt)}${usd(avaxAmt)}`];
  let total = avaxAmt;

  const rows = held.map((h, i) => ({ h, p: priced.get(i) }));
  rows.sort((a, b) => (b.p?.avax ?? -1) - (a.p?.avax ?? -1));
  if (rows.length) lines.push("", "Tokens");
  for (const { h, p } of rows.slice(0, MAX_TOKEN_LINES)) {
    const bal = amt(Number(formatUnits(h.amount, h.dec)));
    if (p) {
      lines.push(`${h.symbol}  ${bal}  ~${amt(p.avax)} AVAX${usd(p.avax)}  ${p.src}`);
    } else if (h.token.toLowerCase() === config.token.toLowerCase() && venue === "curve") {
      lines.push(`${h.symbol}  ${bal}  on Arena curve, no quote yet`);
    } else {
      lines.push(`${h.symbol}  ${bal}  no price found`);
    }
  }
  if (rows.length > MAX_TOKEN_LINES) lines.push(`+${rows.length - MAX_TOKEN_LINES} more tokens`);
  for (const { p } of rows) if (p) total += p.avax;

  lines.push("", `Priced total  ${amt(total)} AVAX${usd(total)}`);
  if (price > 0) lines.push(`AVAX price  $${price.toFixed(2)}`);
  return lines.join("\n");
}

export async function portfolioAll(uid: number) {
  const list = listWallets(uid);
  if (list.length === 0) throw new Error("No wallets yet. Tap Wallets to create or import one.");
  const venue = await currentVenue().catch(() => "unknown");
  const rows: string[] = [];
  for (const w of list) rows.push(await walletSummary(w.label, w.address)); // sequential to stay under the free rate limit
  return { venue, rows };
}