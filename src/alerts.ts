import fs from "node:fs";
import { formatUnits, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import type { Bot } from "grammy";
import { pub } from "./chain.js";
import { config } from "./config.js";
import { routerAbi } from "./abis.js";
import { currentVenue } from "./venue.js";
import { listWallets } from "./db.js";
import { avaxUsd } from "./portfolio.js";
import { sellAll } from "./trade.js";

type Rule = { side: "buy" | "sell"; op: ">" | "<"; usd: number };
type AutoSell = { mcUsd: number; percent: number };
type Prefs = { on: boolean; rules: Rule[]; auto: AutoSell[] };
type Trade = { side: "buy" | "sell"; trader: Address; tokens: number; whole: bigint; hash: Hex; block: bigint };

const FILE = process.env.ALERTS_FILE ?? "alerts.json";
const POLL_MS = 4_000;
const MAX_ALERTS_PER_TICK = 10;
const ZERO = "0x0000000000000000000000000000000000000000";
// Mints that are part of graduation, not buys.
const SKIP_MINT_TO = new Set([config.launch.toLowerCase(), "0x568289b3f3ba28042c5fc527b31cd37fa138e131"]);

const abi = parseAbi([
  "function calculateCost(uint256 amount, uint256 tokenId) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// ---------- storage ----------
let prefs: Record<string, Prefs> = {};
try { prefs = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
const save = () => {
  try { fs.writeFileSync(FILE, JSON.stringify(prefs, null, 2)); } catch (e) { console.error("alerts save failed", e); }
};
const get = (uid: number): Prefs => {
  const p = (prefs[uid] ??= { on: false, rules: [], auto: [] });
  p.rules ??= [];
  p.auto ??= [];
  return p;
};

// ---------- formatting ----------
const num = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const usd = (n: number) => {
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n <= 0) return "$0";
  return `$${n.toFixed(Math.min(12, Math.max(2, 2 - Math.floor(Math.log10(n)))))}`;
};
const big = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `$${(n / 1e3).toFixed(1)}K` : usd(n);
const short = (a: string) => `${a.slice(0, 6)}..${a.slice(-4)}`;

// ---------- market data ----------
let symbolCache = "";
async function symbol(): Promise<string> {
  if (symbolCache) return symbolCache;
  try {
    symbolCache = String(await pub.readContract({ address: config.token, abi, functionName: "symbol" })).slice(0, 10);
  } catch {
    symbolCache = "TOKEN";
  }
  return symbolCache;
}

type Snap = { venue: string; ux: number; priceAvax: number; priceUsd: number; mcUsd: number };
async function snapshot(): Promise<Snap> {
  const [venue, ux, supply] = await Promise.all([
    currentVenue(),
    avaxUsd(),
    pub.readContract({ address: config.token, abi, functionName: "totalSupply" }),
  ]);
  let priceAvax = 0;
  try {
    if (venue === "curve") {
      const c = await pub.readContract({ address: config.launch, abi, functionName: "calculateCost", args: [1n, config.tokenId] });
      priceAvax = Number(formatUnits(c, 18));
    } else {
      const [, out] = await pub.readContract({
        address: config.router, abi: routerAbi, functionName: "getAmountsOut", args: [10n ** 18n, [config.token, config.wavax]],
      });
      priceAvax = Number(formatUnits(out, 18));
    }
  } catch {}
  const priceUsd = priceAvax * ux;
  // Market cap = price x current total supply. Change this line if you want fully diluted instead.
  return { venue, ux, priceAvax, priceUsd, mcUsd: priceUsd * Number(formatUnits(supply, 18)) };
}

async function holdings(uid: number, priceUsd: number) {
  const ws = listWallets(uid);
  if (ws.length === 0) return null;
  const res = (await pub.multicall({
    contracts: ws.map((w) => ({ address: config.token, abi, functionName: "balanceOf", args: [w.address as Address] })) as any,
    allowFailure: true,
  })) as any[];
  let total = 0n;
  for (const r of res) if (r.status === "success") total += r.result as bigint;
  const n = Number(formatUnits(total, 18));
  return { n, usd: n * priceUsd };
}

// AVAX value of a trade, read from curve state at the trade's block. Falls back to spot price.
async function tradeAvax(t: Trade, spotAvax: number): Promise<number> {
  try {
    const v = await pub.readContract({
      address: config.launch, abi, functionName: "calculateCost", args: [t.whole, config.tokenId],
      blockNumber: t.side === "buy" ? t.block - 1n : t.block,
    });
    return Number(formatUnits(v, 18));
  } catch {
    return t.tokens * spotAvax;
  }
}

// ---------- notifications ----------
const send = (bot: Bot, uid: number | string, text: string) =>
  bot.api.sendMessage(Number(uid), text, { link_preview_options: { is_disabled: true } }).catch(() => {});

function passes(p: Prefs, side: "buy" | "sell", valueUsd: number) {
  const rs = p.rules.filter((r) => r.side === side);
  if (rs.length === 0) return true;
  return rs.some((r) => (r.op === ">" ? valueUsd >= r.usd : valueUsd <= r.usd));
}

async function processTrades(bot: Bot, trades: Trade[]) {
  const users = Object.entries(prefs).filter(([, p]) => p.on);
  if (users.length === 0 || trades.length === 0) return;
  const [snap, sym] = await Promise.all([snapshot(), symbol()]);
  const sent = new Map<string, number>();
  const skipped = new Map<string, number>();

  for (const t of trades) {
    const avax = await tradeAvax(t, snap.priceAvax);
    const valueUsd = avax * snap.ux;
    for (const [id, p] of users) {
      if (!passes(p, t.side, valueUsd)) continue;
      const n = sent.get(id) ?? 0;
      if (n >= MAX_ALERTS_PER_TICK) { skipped.set(id, (skipped.get(id) ?? 0) + 1); continue; }
      sent.set(id, n + 1);

      const mine = listWallets(Number(id)).find((w) => w.address.toLowerCase() === t.trader.toLowerCase());
      const h = await holdings(Number(id), snap.priceUsd).catch(() => null);
      const lines = [
        `${t.side === "buy" ? "BUY" : "SELL"}  ${sym}  ${usd(valueUsd)}  (${avax.toFixed(3)} AVAX)`,
        `${num(t.tokens)} ${sym}  ${mine ? `${mine.label} (yours)` : short(t.trader)}`,
        "",
        `Price       ${usd(snap.priceUsd)}`,
        `Market cap  ${big(snap.mcUsd)}`,
      ];
      if (h) lines.push(`Holdings    ${num(h.n)} ${sym}  (${usd(h.usd)})`);
      lines.push("", `https://snowtrace.io/tx/${t.hash}`);
      await send(bot, id, lines.join("\n"));
    }
  }
  for (const [id, n] of skipped) await send(bot, id, `${n} more trades not shown. Tighten your alert rules with /alert.`);
}

// ---------- auto-sell ----------
const hits = new Map<string, number>();
async function checkAutoSell(bot: Bot) {
  const users = Object.entries(prefs).filter(([, p]) => p.auto.length > 0);
  if (users.length === 0) return;
  const snap = await snapshot();
  if (snap.mcUsd <= 0) return; // bad read, never trigger on it
  for (const [id, p] of users) {
    for (const rule of [...p.auto]) {
      const key = `${id}:${rule.mcUsd}:${rule.percent}`;
      if (snap.mcUsd < rule.mcUsd) { hits.delete(key); continue; }
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      if (n < 2) continue; // must hold above target for two checks in a row
      hits.delete(key);
      p.auto = p.auto.filter((r) => r !== rule); // fire once
      save();
      await send(bot, id, `Auto-sell triggered. Market cap ${big(snap.mcUsd)} reached your target of ${big(rule.mcUsd)}. Selling ${rule.percent}% on each wallet...`);
      try {
        const { venue, results } = await sellAll(Number(id), rule.percent);
        await send(bot, id, `Auto-sell via ${venue}\n` + results.map((r) => `${r.label} ${r.ok ? "OK" : "FAIL"}  ${r.info}`).join("\n"));
      } catch (e: any) {
        await send(bot, id, `Auto-sell failed: ${e.message}\nThe rule was removed. Set it again with /autosell if you still want it.`);
      }
    }
  }
}

// ---------- poller ----------
let last = 0n;
let busy = false;

async function tick(bot: Bot) {
  if (busy) return;
  busy = true;
  try {
    const head = await pub.getBlockNumber();
    if (head > last) {
      const from = last + 1n;
      const to = head - from > 1500n ? from + 1500n : head;
      if (Object.values(prefs).some((p) => p.on)) {
        const logs = await pub.getLogs({ address: config.token, event: transferEvent, fromBlock: from, toBlock: to });
        const trades: Trade[] = [];
        for (const l of logs) {
          const { from: a, to: b, value } = l.args;
          if (!a || !b || !value || !l.transactionHash) continue;
          const whole = value / 10n ** 18n;
          if (whole === 0n) continue;
          const tokens = Number(formatUnits(value, 18));
          if (a.toLowerCase() === ZERO && !SKIP_MINT_TO.has(b.toLowerCase())) {
            trades.push({ side: "buy", trader: b, tokens, whole, hash: l.transactionHash, block: l.blockNumber });
          } else if (b.toLowerCase() === ZERO) {
            trades.push({ side: "sell", trader: a, tokens, whole, hash: l.transactionHash, block: l.blockNumber });
          }
        }
        await processTrades(bot, trades);
      }
      last = to;
    }
    await checkAutoSell(bot);
  } catch (e) {
    console.error("alerts tick", e);
  } finally {
    busy = false;
  }
}

export function startAlerts(bot: Bot) {
  const init = () =>
    pub.getBlockNumber().then(
      (b) => { last = b; setInterval(() => void tick(bot), POLL_MS); },
      () => setTimeout(init, 5_000),
    );
  init();
}

// ---------- commands ----------
export function alertsCommand(uid: number, arg: string): string {
  const p = get(uid);
  const a = arg.toLowerCase();
  if (a === "on" || a === "off") {
    p.on = a === "on";
    save();
  }
  const rules = p.rules.length
    ? p.rules.map((r) => `  ${r.side === "buy" ? "Buys" : "Sells"} ${r.op === ">" ? "above" : "below"} ${usd(r.usd)}`).join("\n")
    : "  None. Every trade is sent.";
  return [
    `Trade alerts: ${p.on ? "on" : "off"}`,
    "Rules:",
    rules,
    "",
    "/alerts on  or  /alerts off",
    "/alert buy > 50",
    "/alert sell < 20",
    "/alert clear",
    "A side with no rule sends every trade on that side.",
  ].join("\n");
}

export function alertCommand(uid: number, arg: string): string {
  const p = get(uid);
  const a = arg.trim().toLowerCase();
  if (a === "clear") {
    p.rules = [];
    save();
    return "Alert rules cleared. Every trade will be sent.\n\n" + alertsCommand(uid, "");
  }
  const m = a.match(/^(buy|sell)\s*([<>])\s*\$?(\d+(?:\.\d+)?)$/);
  if (!m) return "Usage: /alert buy > 50  or  /alert sell < 20  or  /alert clear";
  const rule: Rule = { side: m[1] as "buy" | "sell", op: m[2] as ">" | "<", usd: Number(m[3]) };
  p.rules = p.rules.filter((r) => !(r.side === rule.side && r.op === rule.op));
  p.rules.push(rule);
  p.on = true;
  save();
  return alertsCommand(uid, "");
}

function parseMc(s: string): number | null {
  const m = s.replace(/[$,]/g, "").match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
  return Number(m[1]) * mult;
}

export async function autosellCommand(uid: number, arg: string): Promise<string> {
  const p = get(uid);
  const a = arg.trim().toLowerCase();
  if (a === "clear") {
    p.auto = [];
    save();
    return "Auto-sell rules cleared.";
  }
  if (a !== "") {
    const parts = a.split(/\s+/);
    const mc = parseMc(parts[0]);
    const pct = parts[1] ? Number(parts[1].replace("%", "")) : 100;
    if (!mc || !Number.isFinite(pct) || pct < 1 || pct > 100) {
      return "Usage: /autosell 500000  or  /autosell 1.5m 50%\nFirst value is the market cap in dollars (k, m, b allowed). Second is the percent of each wallet to sell, default 100%.";
    }
    if (listWallets(uid).length === 0) return "No wallets yet. Tap Wallets to create or import one first.";
    const snap = await snapshot();
    if (snap.mcUsd <= 0) return "Could not read the market cap right now. Try again in a moment.";
    if (mc <= snap.mcUsd) return `Current market cap is ${big(snap.mcUsd)}. Pick a target above it. Auto-sell only triggers on the way up.`;
    p.auto.push({ mcUsd: mc, percent: pct });
    save();
  }
  const snap = await snapshot().catch(() => null);
  const rules = p.auto.length
    ? p.auto.map((r) => `  Sell ${r.percent}% at ${big(r.mcUsd)}`).join("\n")
    : "  None.";
  return [
    snap ? `Current market cap: ${big(snap.mcUsd)}` : "",
    "Auto-sell rules:",
    rules,
    "",
    "/autosell 500000",
    "/autosell 1.5m 50%",
    "/autosell clear",
    "A rule runs once, after the market cap holds above the target for two checks, then is removed.",
  ].filter((l, i) => l !== "" || i > 0).join("\n");
}