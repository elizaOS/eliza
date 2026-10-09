/**
 * Service-to-service signing between the Eliza gateway / shared agent and the Network service
 * (eliza-research/thenetwork docs/design/eliza-conversation-layer.md). Mirrored byte-for-byte in the
 * service (packages/core/src/svc/svc-auth.ts). No imports: WebCrypto only, so it runs in Workerd and Bun.
 *
 *   canonical = METHOD \n PATH \n TS \n ID \n hex(sha256(body))
 *   x-ntwrk-svc-ts  = unix seconds
 *   x-ntwrk-svc-id  = the request id (the inbound messageId for /internal/turn; the idempotency key for /internal/deliver)
 *   x-ntwrk-svc-sig = hex(HMAC-SHA256(SERVICE_TURN_SECRET, canonical))
 * Requests older or newer than 60 s are rejected. Replays inside the window are harmless: both
 * endpoints are idempotent by id.
 */

export const SVC_TS_HEADER = "x-ntwrk-svc-ts";
export const SVC_ID_HEADER = "x-ntwrk-svc-id";
export const SVC_SIG_HEADER = "x-ntwrk-svc-sig";
export const SVC_MAX_SKEW_S = 60;
/** Minimum secret length (bytes of the UTF-8 string). */
export const SVC_MIN_SECRET = 32;

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sha256Hex(body: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(body)));
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

export async function svcCanonical(method: string, path: string, ts: number, id: string, body: string): Promise<string> {
  return `${method.toUpperCase()}\n${path}\n${ts}\n${id}\n${await sha256Hex(body)}`;
}

function assertSecret(secret: string | undefined): asserts secret is string {
  if (!secret || secret.length < SVC_MIN_SECRET) throw new Error(`SERVICE_TURN_SECRET missing or shorter than ${SVC_MIN_SECRET} characters`);
}

/** Headers for a signed request. `path` is the URL pathname only (no query). */
export async function svcSign(
  secret: string | undefined,
  req: { method: string; path: string; id: string; body: string; nowS?: number },
): Promise<Record<string, string>> {
  assertSecret(secret);
  const ts = req.nowS ?? Math.floor(Date.now() / 1000);
  const sig = await hmacHex(secret, await svcCanonical(req.method, req.path, ts, req.id, req.body));
  return { [SVC_TS_HEADER]: String(ts), [SVC_ID_HEADER]: req.id, [SVC_SIG_HEADER]: sig };
}

export type SvcVerify = { ok: true; id: string } | { ok: false; reason: "missing" | "stale" | "bad_signature" | "no_secret" };

/** Verifies a request against the raw body. Constant-time compare. */
export async function svcVerify(
  secret: string | undefined,
  req: { method: string; path: string; headers: { get(name: string): string | null }; body: string; nowS?: number },
): Promise<SvcVerify> {
  if (!secret || secret.length < SVC_MIN_SECRET) return { ok: false, reason: "no_secret" };
  const ts = Number(req.headers.get(SVC_TS_HEADER));
  const id = req.headers.get(SVC_ID_HEADER);
  const sig = req.headers.get(SVC_SIG_HEADER);
  if (!Number.isFinite(ts) || !id || !sig) return { ok: false, reason: "missing" };
  const now = req.nowS ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SVC_MAX_SKEW_S) return { ok: false, reason: "stale" };
  const want = await hmacHex(secret, await svcCanonical(req.method, req.path, ts, id, req.body));
  if (want.length !== sig.length) return { ok: false, reason: "bad_signature" };
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { ok: true, id } : { ok: false, reason: "bad_signature" };
}
