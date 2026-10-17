import { maxUint256 } from "viem";
import { pub, makeWallet, type Wallet } from "./chain.js";
import { loadSigners } from "./db.js";
import { config } from "./config.js";
import { erc20Abi, routerAbi } from "./abis.js";
import { currentVenue } from "./venue.js";
import { requireAvax, requireGas, ensureAllowance, fmtTok } from "./checks.js";
import { curveBuy, curveSell } from "./curve.js";
import { dexBuy, dexSell } from "./dex.js";

export type Result = { label: string; ok: boolean; info: string };

function walletsFor(uid: number): Wallet[] {
  const list = loadSigners(uid).map((s) => makeWallet(s.label, s.key));
  if (list.length === 0) throw new Error("No wallets yet. Send /newwallet first.");
  return list;
}

const spender = (v: "curve" | "dex") => (v === "curve" ? config.launch : config.router);

async function settle(label: string, send: () => Promise<`0x${string}`>): Promise<Result> {
  try {
    const hash = await send();
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    return { label, ok: r.status === "success", info: `https://snowtrace.io/tx/${hash}` };
  } catch (e: any) {
    return { label, ok: false, info: (e.shortMessage ?? e.message ?? "error").slice(0, 120) };
  }
}

export async function buyAll(uid: number, avax: string): Promise<{ venue: string; results: Result[] }> {
  const wallets = walletsFor(uid);
  const venue = await currentVenue();
  const fn = venue === "curve" ? curveBuy : dexBuy;
    const results = await Promise.all(wallets.map((w) => settle(w.label, async () => { await requireAvax(w, avax); return fn(w, avax); })));
  return { venue, results };
}
export async function sellAll(uid: number, percent: number, exactTokens?: bigint): Promise<{ venue: string; results: Result[] }> {
  const wallets = walletsFor(uid);
  const venue = await currentVenue();
  const fn = venue === "curve" ? curveSell : dexSell;
  const results = await Promise.all(
    wallets.map((w) =>
      settle(w.label, async () => {
        const bal = await pub.readContract({
          address: config.token, abi: erc20Abi, functionName: "balanceOf", args: [w.account.address],
        });
                const amount = exactTokens !== undefined ? exactTokens : (bal * BigInt(percent)) / 100n;
        if (exactTokens !== undefined && bal < exactTokens) throw new Error(`Not enough tokens: needs ${fmtTok(exactTokens)}, has ${fmtTok(bal)}`);
                if (amount === 0n) throw new Error("No tokens in this wallet.");
        await requireGas(w);
        if (venue === "dex") await ensureAllowance(w, config.router, amount);
        return fn(w, amount);
      }),
    ),
  );
  return { venue, results };
}

// Pre-approve so sells do not need an extra tx at the moment you want out.
export async function approveAll(uid: number): Promise<Result[]> {
  const wallets = walletsFor(uid);
  const venue = await currentVenue();
  const target = spender(venue);
  return Promise.all(
    wallets.map((w) =>
      settle(w.label, async () => {
        const a = await pub.readContract({
          address: config.token, abi: erc20Abi, functionName: "allowance", args: [w.account.address, target],
        });
        if (a > 10n ** 30n) throw new Error("already approved");
        return w.client.writeContract({
          address: config.token, abi: erc20Abi, functionName: "approve", args: [target, maxUint256],
        });
      }),
    ),
  );
}

export async function statusAll(uid: number) {
  const wallets = walletsFor(uid);
  const venue = await currentVenue();
  const rows = await Promise.all(
    wallets.map(async (w) => {
      const [avax, tok] = await Promise.all([
        pub.getBalance({ address: w.account.address }),
        pub.readContract({ address: config.token, abi: erc20Abi, functionName: "balanceOf", args: [w.account.address] }),
      ]);
            let worth = "";
      if (venue === "dex" && tok > 0n) {
        try {
          const [, out] = await pub.readContract({
            address: config.router, abi: routerAbi, functionName: "getAmountsOut",
            args: [tok, [config.token, config.wavax]],
          });
          worth = `  (~${(Number(out) / 1e18).toFixed(3)} AVAX)`;
        } catch {}
      }
      return `${w.label} ${w.account.address.slice(0, 6)}..${w.account.address.slice(-4)}  AVAX ${(Number(avax) / 1e18).toFixed(3)}  TOK ${(Number(tok) / 1e18).toFixed(2)}${worth}`;
    }),
  );
  return { venue, rows };
}