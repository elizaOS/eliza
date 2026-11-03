import { createHmac, createSign } from "node:crypto";
import type { AlertEvent } from "./connection-vault.ts";
import { publicText } from "./connection-vault.ts";
import type { CoinSnapshot, Evaluation } from "./evaluate.ts";
import { redactSecrets } from "./net.ts";
import { answerTools } from "./offers.ts";

const MINT_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const TAG_RE = /\$([A-Za-z][A-Za-z0-9]{1,12})\b/g;

export function mintsAndTags(text: string): { mints: string[]; tags: string[] } {
  const mints = [...text.matchAll(MINT_RE)].map((hit) => hit[0]);
  const tags = [...text.matchAll(TAG_RE)].map((hit) => hit[1] ?? "").filter(Boolean);
  return { mints: [...new Set(mints)], tags: [...new Set(tags)] };
}

/** Read-only recent search. This function never posts. */
export async function searchX(
  bearer: string,
  query: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ mints: string[]; tags: string[] }> {
  const url = new URL("https://api.x.com/2/tweets/search/recent");
  url.searchParams.set("query", query);
  url.searchParams.set("max_results", "10");
  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`X search HTTP ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ text?: string }> };
  const text = (body.data ?? []).map((row) => row.text ?? "").join("\n");
  return mintsAndTags(text);
}

export function signalsThatPass(
  rows: Array<{ mint: string; snapshot: CoinSnapshot }>,
  evaluate: (snapshot: CoinSnapshot) => Evaluation
): Array<{ mint: string; ok: boolean; reason: string }> {
  return rows.map((row) => {
    const result = evaluate(row.snapshot);
    return { mint: row.mint, ok: result.ok, reason: result.reason };
  });
}

export function alertAllowed(toggles: Record<AlertEvent, boolean>, event: AlertEvent): boolean {
  return toggles[event] === true;
}

export function alertLine(event: AlertEvent, detail: string): string {
  return publicText(`${event}: ${detail}`).slice(0, 240);
}

export async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
  limit = 240,
  keepLinks = false
): Promise<void> {
  const shown = (keepLinks ? redactSecrets(text) : publicText(text)).slice(0, limit);
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: shown }),
  });
  if (!response.ok) throw new Error("Telegram did not accept the alert.");
}

/** Reads bot updates and answers /tools. Other messages stay untouched. */
export async function pollTelegramTools(
  token: string,
  offset: number,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  const response = await fetchImpl(
    `https://api.telegram.org/bot${token}/getUpdates?timeout=0&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`
  );
  if (!response.ok) return offset;
  const body = (await response.json()) as {
    result?: Array<{ update_id?: number; message?: { text?: string; chat?: { id?: number } } }>;
  };
  let next = offset;
  for (const update of body.result ?? []) {
    const id = Number(update.update_id ?? 0);
    if (id >= next) next = id + 1;
    const reply = answerTools(update.message?.text ?? "");
    const chatId = update.message?.chat?.id;
    if (!reply || chatId == null) continue;
    await sendTelegram(token, String(chatId), reply, fetchImpl, 3500, true);
  }
  return next;
}

export async function sendDiscord(
  webhook: string,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: publicText(text).slice(0, 240) }),
  });
  if (!response.ok) throw new Error("Discord did not accept the alert.");
}

export function pnlCsv(rows: Array<{ t: string; symbol: string; pnlSol: number }>): string {
  const lines = [
    "time,symbol,pnl_sol",
    ...rows.map((row) => `${row.t},${row.symbol},${row.pnlSol}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function rejectTradePermission(flags: {
  trade?: boolean;
  withdraw?: boolean;
}): string | null {
  if (flags.withdraw) return "This key can withdraw. Create a view-only key.";
  if (flags.trade) return "This key can trade. Create a view-only key.";
  return null;
}

export async function binanceBalances(
  key: string,
  secret: string,
  fetchImpl: typeof fetch
): Promise<{ ok: boolean; message: string; balances: Array<{ asset: string; free: string }> }> {
  const stamp = Date.now();
  const query = `timestamp=${stamp}`;
  const sign = createHmac("sha256", secret).update(query).digest("hex");
  const flags = await fetchImpl(
    `https://api.binance.com/sapi/v1/account/apiRestrictions?${query}&signature=${sign}`,
    {
      headers: { "X-MBX-APIKEY": key },
    }
  );
  const perm = (await flags.json()) as {
    enableWithdrawals?: boolean;
    enableSpotAndMarginTrading?: boolean;
  };
  const blocked = rejectTradePermission({
    withdraw: perm.enableWithdrawals === true,
    trade: perm.enableSpotAndMarginTrading === true,
  });
  if (blocked) return { ok: false, message: blocked, balances: [] };
  const accountQuery = `timestamp=${stamp}`;
  const accountSign = createHmac("sha256", secret).update(accountQuery).digest("hex");
  const account = await fetchImpl(
    `https://api.binance.com/api/v3/account?${accountQuery}&signature=${accountSign}`,
    { headers: { "X-MBX-APIKEY": key } }
  );
  const body = (await account.json()) as { balances?: Array<{ asset: string; free: string }> };
  return {
    ok: account.ok,
    message: account.ok ? "Read-only balances." : "Binance refused the read.",
    balances: (body.balances ?? []).filter((row) => Number(row.free) > 0).slice(0, 12),
  };
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export async function sheetsAccessToken(
  secret: string,
  fetchImpl: typeof fetch
): Promise<{ token: string; spreadsheetId: string }> {
  const parsed = JSON.parse(secret) as {
    spreadsheetId?: string;
    access_token?: string;
    client_email?: string;
    private_key?: string;
  };
  const spreadsheetId = parsed.spreadsheetId ?? "";
  if (!spreadsheetId) throw new Error("Add a spreadsheet id.");
  if (parsed.access_token) return { token: parsed.access_token, spreadsheetId };
  if (!parsed.client_email || !parsed.private_key) throw new Error("Sheets key is incomplete.");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: parsed.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const assertion = `${header}.${claim}.${signer.sign(parsed.private_key).toString("base64url")}`;
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("Google did not return a sheet token.");
  return { token: body.access_token, spreadsheetId };
}

export async function appendSheet(
  token: string,
  spreadsheetId: string,
  rows: string[][],
  fetchImpl: typeof fetch
): Promise<void> {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    "/values/P%26L!A1:append?valueInputOption=RAW";
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ values: rows }),
  });
  if (!response.ok) throw new Error("Sheets did not append the rows.");
}
