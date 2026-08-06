/**
 * RPC multiplexer — Helius primary, SolanaTracker fallback.
 *
 * Every Solana RPC call in the gateway goes through `rpcCall` so we get:
 *   - automatic failover if Helius is rate-limited or slow
 *   - per-request retries with exponential backoff (3 attempts)
 *   - a single place to add caching later (Cloudflare Cache API friendly)
 */

import type { Env } from "../types";

interface RpcOptions {
  timeoutMs?: number;
  /** Force a specific provider (for testing) */
  provider?: "helius" | "solanatracker";
}

function heliusUrl(env: Env): string {
  const net = env.NETWORK === "solana-devnet" ? "devnet" : "mainnet";
  return `https://${net}.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
}

function solanaTrackerUrl(env: Env): string {
  // SolanaTracker exposes an RPC proxy on their enterprise plan; check their docs for the
  // exact URL shape. This is a placeholder that matches their public gateway.
  return `https://rpc.solanatracker.io/public?advancedTx=true&apiKey=${env.SOLANATRACKER_API_KEY}`;
}

export async function rpcCall<T = unknown>(
  env: Env,
  method: string,
  params: unknown[],
  opts: RpcOptions = {},
): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params });
  const timeoutMs = opts.timeoutMs ?? 8000;

  const providers: Array<"helius" | "solanatracker"> = opts.provider
    ? [opts.provider]
    : ["helius", "solanatracker"];

  let lastError: unknown;

  for (const provider of providers) {
    const url = provider === "helius" ? heliusUrl(env) : solanaTrackerUrl(env);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        });
        clearTimeout(t);

        if (!res.ok) {
          if (res.status === 429 || res.status >= 500) {
            // rate-limited or server error — retry (or fail over)
            await sleep(200 * 2 ** attempt);
            continue;
          }
          throw new Error(`RPC ${provider} ${method} ${res.status}: ${await res.text()}`);
        }

        const json = (await res.json()) as { result?: T; error?: { message: string } };
        if (json.error) throw new Error(`RPC ${method} error: ${json.error.message}`);
        return json.result as T;
      } catch (err) {
        lastError = err;
        await sleep(200 * 2 ** attempt);
      }
    }
  }

  throw new Error(
    `All RPC providers failed for ${method}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ——— convenience wrappers ——— */

export async function getLatestBlockhash(env: Env): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const r = await rpcCall<{ value: { blockhash: string; lastValidBlockHeight: number } }>(env, "getLatestBlockhash", [
    { commitment: "finalized" },
  ]);
  return r.value;
}

export async function sendRawTransaction(env: Env, base64Tx: string): Promise<string> {
  // Broadcast via both providers in parallel for the highest landing probability —
  // same tx, same signature, RPC will dedupe.
  const broadcast = (provider: "helius" | "solanatracker") =>
    rpcCall<string>(env, "sendTransaction", [base64Tx, { encoding: "base64", skipPreflight: false, maxRetries: 3 }], {
      provider,
      timeoutMs: 10000,
    }).catch((e) => ({ __err: e }));

  const [h, s] = await Promise.all([broadcast("helius"), broadcast("solanatracker")]);
  if (typeof h === "string") return h;
  if (typeof s === "string") return s;
  throw new Error(`Broadcast failed on both providers`);
}

export async function getTokenAccountBalance(env: Env, ata: string): Promise<bigint> {
  const r = await rpcCall<{ value: { amount: string } }>(env, "getTokenAccountBalance", [ata]);
  return BigInt(r.value.amount);
}

export async function simulateTransaction(env: Env, base64Tx: string): Promise<{ logs: string[]; err: unknown }> {
  const r = await rpcCall<{ value: { logs: string[]; err: unknown } }>(env, "simulateTransaction", [
    base64Tx,
    { encoding: "base64", sigVerify: true, replaceRecentBlockhash: false },
  ]);
  return r.value;
}

export async function getSignatureStatus(env: Env, sig: string): Promise<{ confirmationStatus?: string; err: unknown } | null> {
  const r = await rpcCall<{ value: Array<{ confirmationStatus?: string; err: unknown } | null> }>(
    env,
    "getSignatureStatuses",
    [[sig], { searchTransactionHistory: true }],
  );
  return r.value[0];
}
