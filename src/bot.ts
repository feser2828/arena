import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { buyAll, sellAll, approveAll, statusAll, type Result } from "./trade.js";
import { createWallet, importWallet, listWallets, exportKey, removeWallet, walletSource } from "./db.js";
import { portfolioAll, walletSummary } from "./portfolio.js";
import { parseAmount, previewOrder, runOrder, type Order } from "./plan.js";
import { startAlerts, alertsCommand, alertCommand, autosellCommand, tradesCommand } from "./alerts.js";

const pendingImport = new Set<number>();

const bot = new Bot(config.botToken);

// Private chats only, so keys and balances never appear in a group.
bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.chat?.type !== "private") return;
  await next();
});

const fmt = (title: string, rs: Result[]) =>
  `${title}\n` + rs.map((r) => `${r.label} ${r.ok ? "OK" : "FAIL"}  ${r.info}`).join("\n");

const menu = new InlineKeyboard()
    .text("Buy $10", "bq:10").text("Buy $25", "bq:25").text("Buy $50", "bq:50").text("Buy $100", "bq:100").row()
  .text("Buy custom amount", "bq:custom").row()
    .text("Sell 25%", "sq:25%").text("Sell 50%", "sq:50%").text("Sell 100%", "sq:100%").row()
  .text("Sell custom amount", "sq:custom").row()
    .text("Status", "status").text("Wallets", "wallets").row()
  .text("Alerts", "alerts").text("Auto-sell", "autosell").text("Trades", "trades");

bot.command("start", (ctx) =>
  ctx.reply("Tap Wallets to create a new wallet or import one you already own, then use the buttons below to trade.", { reply_markup: menu }));

bot.command("buy", async (ctx) => {
  const amt = ctx.match.trim();
    if (!amt) return ctx.reply("Usage: /buy 25 (dollars) or /buy 0.5 avax");
  await doBuy(ctx, amt);
});
bot.command("sell", async (ctx) => {
    const p = ctx.match.trim();
    if (!p) return ctx.reply("Usage: /sell 25 (dollars) or /sell 50%");
  await doSell(ctx, p);
});
bot.command("approve", async (ctx) => ctx.reply(fmt("Approve", await approveAll(ctx.from!.id))));

bot.command("newwallet", async (ctx) => {
  try {
    const w = createWallet(ctx.from!.id);
    await ctx.reply(`Created ${w.label}\nSend AVAX to this address to fund it:\n${w.address}`);
  } catch (e: any) {
    await ctx.reply(e.message);
  }
});
bot.command("import", async (ctx) => {
  const raw = ctx.match.trim();
  // Delete the message first so the key does not sit in the chat.
  await ctx.api.deleteMessage(ctx.chat.id, ctx.message!.message_id).catch(() => {});
    if (!raw) {
    pendingImport.add(ctx.from!.id);
    return ctx.reply("Send the private key of the wallet you want to import as your next message. It is deleted as soon as it arrives. Send /cancel to abort.");
  }
  try {
    const w = importWallet(ctx.from!.id, raw);
    await ctx.reply(`Imported as ${w.label}\n${w.address}\nYour message containing the key was deleted.`);
  } catch (e: any) {
    await ctx.reply(e.message);
  }
});
bot.command("wallets", (ctx) => doWallets(ctx));
bot.command("export", async (ctx) => {
  const label = ctx.match.trim().toUpperCase();
  const key = exportKey(ctx.from!.id, label);
  if (!key) return ctx.reply("Usage: /export W1");
  const m = await ctx.reply(`Private key for ${label}:\n${key}\n\nThis message deletes itself in 60 seconds. Store it somewhere safe.`);
  setTimeout(() => ctx.api.deleteMessage(m.chat.id, m.message_id).catch(() => {}), 60_000);
});
bot.command("status", async (ctx) => doStatus(ctx));
bot.command("alerts", async (ctx) => ctx.reply(alertsCommand(ctx.from!.id, ctx.match.trim())));
bot.command("trades", async (ctx) => {
  await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  await ctx.reply(await tradesCommand(ctx.from!.id), { link_preview_options: { is_disabled: true } });
});
bot.callbackQuery("trades", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.api.sendChatAction(ctx.from.id, "typing").catch(() => {});
  await ctx.reply(await tradesCommand(ctx.from.id), { link_preview_options: { is_disabled: true } });
});
bot.command("alert", async (ctx) => ctx.reply(alertCommand(ctx.from!.id, ctx.match.trim())));
bot.command("autosell", async (ctx) => ctx.reply(await autosellCommand(ctx.from!.id, ctx.match.trim())));
bot.callbackQuery("alerts", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply(alertsCommand(ctx.from.id, "")); });
bot.callbackQuery("autosell", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply(await autosellCommand(ctx.from.id, "")); });

bot.callbackQuery(/^buy:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await doBuy(ctx, `${ctx.match[1]} avax`); });
bot.callbackQuery(/^sell:(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await doSell(ctx, `${ctx.match[1]}%`); });
bot.callbackQuery("status", async (ctx) => { await ctx.answerCallbackQuery(); await doStatus(ctx); });
bot.callbackQuery("wallets", async (ctx) => { await ctx.answerCallbackQuery(); await doWallets(ctx); });

const pendingAmount = new Map<number, "buy" | "sell">();
const pendingOrder = new Map<number, Order>();

async function showPreview(ctx: any, o: Order) {
  try {
    const p = await previewOrder(ctx.from.id, o);
    const kb = new InlineKeyboard();
    if (p.ready) {
      pendingOrder.set(ctx.from.id, o);
      kb.text("Confirm", "order:go").text("Cancel", "order:no");
      await ctx.reply(p.text, { reply_markup: kb });
    } else {
      await ctx.reply(`${p.text}\n\nNo wallet can complete this order.`);
    }
  } catch (e: any) {
    await ctx.reply(e.message);
  }
}

async function doBuy(ctx: any, raw: string) {
  const o = parseAmount("buy", raw);
  if (!o) return ctx.reply("Type an amount in dollars, like 25, or an AVAX amount, like 0.5 avax.");
  await showPreview(ctx, o);
}
async function doSell(ctx: any, raw: string) {
  const o = parseAmount("sell", raw);
  if (!o) return ctx.reply("Type an amount in dollars, like 25, or a percentage, like 50%.");
  await showPreview(ctx, o);
}

bot.callbackQuery(/^bq:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const v = ctx.match[1];
  if (v === "custom") {
    pendingAmount.set(ctx.from.id, "buy");
    return ctx.reply("Type how many dollars to buy on each wallet, for example 25. You can also type an AVAX amount, like 0.5 avax. Send /cancel to stop.");
  }
  await doBuy(ctx, v);
});

bot.callbackQuery(/^sq:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const v = ctx.match[1];
  if (v === "custom") {
    pendingAmount.set(ctx.from.id, "sell");
    return ctx.reply("Type how many dollars to sell on each wallet, for example 25, or a percentage like 50%. Send /cancel to stop.");
  }
  await doSell(ctx, v);
});

bot.callbackQuery("order:no", async (ctx) => {
  await ctx.answerCallbackQuery();
  pendingOrder.delete(ctx.from.id);
  await ctx.reply("Cancelled.");
});

bot.callbackQuery("order:go", async (ctx) => {
  await ctx.answerCallbackQuery();
  const o = pendingOrder.get(ctx.from.id);
  if (!o) return ctx.reply("Nothing to confirm. Start a new order from the menu.");
  pendingOrder.delete(ctx.from.id); // a second tap finds nothing, so orders cannot fire twice
  await ctx.reply("Sending orders...");
  try {
    const { venue, results } = await runOrder(ctx.from.id, o);
    await ctx.reply(fmt(`${o.side === "buy" ? "Buy" : "Sell"} via ${venue}`, results), { link_preview_options: { is_disabled: true } });
  } catch (e: any) {
    await ctx.reply(e.message);
  }
});
async function doStatus(ctx: any) {
    await ctx.api.sendChatAction(ctx.from.id, "typing").catch(() => {});
  const { venue, rows } = await portfolioAll(ctx.from.id);
  for (const [i, r] of rows.entries()) await ctx.reply(i === 0 ? `Venue: ${venue}\n\n${r}` : r);
}

async function doWallets(ctx: any) {
  const list = listWallets(ctx.from.id);
  const kb = new InlineKeyboard();
  for (const w of list) kb.text(`Export ${w.label}`, `exp:${w.label}`).text(`Disconnect ${w.label}`, `del:${w.label}`).row();
  kb.text("Create new wallet", "w:new").text("Import wallet", "w:import");
  if (list.length === 0) return ctx.reply("No wallets connected yet. Create a new wallet or import one you already own.", { reply_markup: kb });
    await ctx.reply(list.map((w) => `${w.label}\n${w.address}`).join("\n\n"), { reply_markup: kb });
}

bot.callbackQuery("w:new", async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    const w = createWallet(ctx.from.id);
    await ctx.reply(`Created ${w.label}\nSend AVAX to this address to fund it:\n${w.address}`);
  } catch (e: any) {
    await ctx.reply(e.message);
  }
});

bot.callbackQuery("w:import", async (ctx) => {
  await ctx.answerCallbackQuery();
  pendingImport.add(ctx.from.id);
  await ctx.reply("Send the private key of the wallet you want to import as your next message. It is deleted as soon as it arrives. Send /cancel to abort.");
});

bot.callbackQuery(/^exp:(W\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const label = ctx.match[1];
  const key = exportKey(ctx.from.id, label);
  if (!key) return ctx.reply("Wallet not found.");
  const m = await ctx.reply(`Private key for ${label}:\n${key}\n\nThis message deletes itself in 60 seconds. Store it somewhere safe.`);
  setTimeout(() => ctx.api.deleteMessage(m.chat.id, m.message_id).catch(() => {}), 60_000);
});

bot.callbackQuery(/^del:(W\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const label = ctx.match[1];
  const src = walletSource(ctx.from.id, label);
  if (!src) return ctx.reply("Wallet not found.");
  const warn = src === "created"
    ? `${label} was created by this bot, so the bot holds the only copy of its private key. If it has funds and you disconnect without exporting the key, those funds are lost permanently.`
    : `${label} is an imported wallet. Disconnecting only removes it from the bot. Your funds stay on the wallet and you keep your own key.`;
  const kb = new InlineKeyboard();
  if (src === "created") kb.text(`Export ${label} first`, `exp:${label}`).row();
  kb.text("Disconnect", `delok:${label}`).text("Cancel", "wallets");
  await ctx.reply(warn, { reply_markup: kb });
});

bot.callbackQuery(/^delok:(W\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const label = ctx.match[1];
  const ok = removeWallet(ctx.from.id, label);
  await ctx.reply(ok ? `${label} disconnected. Its key has been deleted from the bot.` : "Wallet not found.",
    { reply_markup: new InlineKeyboard().text("Wallets", "wallets") });
});

bot.command("cancel", async (ctx) => {
    pendingImport.delete(ctx.from!.id);
  pendingAmount.delete(ctx.from!.id);
  pendingOrder.delete(ctx.from!.id);
  await ctx.reply("Cancelled.");
});

bot.on("message:text", async (ctx) => {
    const kind = pendingAmount.get(ctx.from.id);
  if (kind && !ctx.message.text.startsWith("/")) {
    pendingAmount.delete(ctx.from.id);
    return kind === "buy" ? doBuy(ctx, ctx.message.text) : doSell(ctx, ctx.message.text);
  }
  if (!pendingImport.has(ctx.from.id)) return;
  if (ctx.message.text.startsWith("/")) return;
  pendingImport.delete(ctx.from.id);
  await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
  try {
    const w = importWallet(ctx.from.id, ctx.message.text);
    await ctx.reply(`Imported as ${w.label}\n${w.address}`, { reply_markup: new InlineKeyboard().text("Wallets", "wallets") });
    walletSummary(w.label, w.address).then((t) => ctx.reply(t)).catch(() => ctx.reply("Could not load balances right now. Tap Status to retry."));
  } catch (e: any) {
    await ctx.reply(`${e.message} Tap Import wallet to try again.`, { reply_markup: new InlineKeyboard().text("Wallets", "wallets") });
  }
});

bot.api.setMyCommands([
  { command: "start", description: "Open the menu" },
  { command: "wallets", description: "Manage wallets" },
  { command: "newwallet", description: "Create a wallet" },
  { command: "import", description: "Import an existing wallet" },
  { command: "status", description: "Balances" },
    { command: "buy", description: "Buy in dollars, e.g. /buy 25" },
    { command: "sell", description: "Sell, e.g. /sell 25 or /sell 50%" },
  { command: "alerts", description: "Trade alerts on or off" },
  { command: "trades", description: "Last 5 trades" },
  { command: "alert", description: "Alert rule, e.g. /alert buy > 50" },
  { command: "autosell", description: "Sell at a market cap, e.g. /autosell 1m" },
]).catch(() => {});

bot.catch(async (e) => {
  console.error(e.error);
  try { await e.ctx.reply(String((e.error as any)?.message ?? "Error").slice(0, 200)); } catch {}
});
startAlerts(bot);
bot.start();
