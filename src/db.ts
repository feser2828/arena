import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { config } from "./config.js";

const db = new DatabaseSync("bot.db");
db.exec(`CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  address TEXT NOT NULL,
  enc_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);
db.exec("CREATE INDEX IF NOT EXISTS wallets_user ON wallets(user_id)");
try { db.exec("ALTER TABLE wallets ADD COLUMN source TEXT NOT NULL DEFAULT 'created'"); } catch {}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", config.masterKey, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}

function decrypt(b64: string): string {
  const raw = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-256-gcm", config.masterKey, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

export const MAX_WALLETS = 5;

export function createWallet(userId: number) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM wallets WHERE user_id = ?").get(userId) as { n: number };
  if (row.n >= MAX_WALLETS) throw new Error(`Limit of ${MAX_WALLETS} wallets reached`);
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
    const label = nextLabel(userId);
  db.prepare("INSERT INTO wallets (user_id, label, address, enc_key, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(userId, label, address, encrypt(key), Date.now());
  return { label, address };
}

export function importWallet(userId: number, rawKey: string) {
  let key = rawKey.trim();
  if (!key.startsWith("0x")) key = "0x" + key;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("That is not a valid private key (64 hex characters).");
  const address = privateKeyToAccount(key as Hex).address;
  const rows = db.prepare("SELECT address FROM wallets WHERE user_id = ?").all(userId) as { address: string }[];
  if (rows.length >= MAX_WALLETS) throw new Error(`Limit of ${MAX_WALLETS} wallets reached`);
  if (rows.some((r) => r.address.toLowerCase() === address.toLowerCase())) throw new Error("That wallet is already added.");
    const label = nextLabel(userId);
  db.prepare("INSERT INTO wallets (user_id, label, address, enc_key, created_at, source) VALUES (?, ?, ?, ?, ?, 'imported')")
    .run(userId, label, address, encrypt(key), Date.now());
  return { label, address };
}

function nextLabel(userId: number): string {
  const rows = db.prepare("SELECT label FROM wallets WHERE user_id = ?").all(userId) as { label: string }[];
  const max = rows.reduce((m, r) => Math.max(m, Number(r.label.slice(1)) || 0), 0);
  return `W${max + 1}`;
}

export function walletSource(userId: number, label: string): string | null {
  const r = db.prepare("SELECT source FROM wallets WHERE user_id = ? AND label = ?").get(userId, label) as
    { source: string } | undefined;
  return r ? r.source : null;
}

export function removeWallet(userId: number, label: string): boolean {
  const r = db.prepare("DELETE FROM wallets WHERE user_id = ? AND label = ?").run(userId, label);
  return Number(r.changes) > 0;
}

export function listWallets(userId: number) {
  return db.prepare("SELECT label, address FROM wallets WHERE user_id = ? ORDER BY id").all(userId) as
    { label: string; address: string }[];
}

export function loadSigners(userId: number) {
  const rows = db.prepare("SELECT label, enc_key FROM wallets WHERE user_id = ? ORDER BY id").all(userId) as
    { label: string; enc_key: string }[];
  return rows.map((r) => ({ label: r.label, key: decrypt(r.enc_key) as Hex }));
}

export function exportKey(userId: number, label: string): string | null {
  const r = db.prepare("SELECT enc_key FROM wallets WHERE user_id = ? AND label = ?").get(userId, label) as
    { enc_key: string } | undefined;
  return r ? decrypt(r.enc_key) : null;
}