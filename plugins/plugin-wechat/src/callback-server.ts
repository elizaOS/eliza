/**
 * Public callback HTTP surface for first-party WeChat platforms: `GET` URL
 * verification (echo/echostr handshake) and `POST` message delivery. The
 * security mode is taken from the RESOLVED ACCOUNT (never from request
 * shape), so an encrypted-mode account cannot be downgraded to the plaintext
 * verification path; the outer encrypted envelope is extracted with the
 * hardened parser (WeCom's documented sequence) but no decrypted or business
 * payload is parsed before signature verification succeeds, and the embedded
 * receiver id must match the addressed account. Accounts are addressed by id
 * in the path (`/webhook/wechat/<accountId>`); a payload signed or encrypted
 * for one account can never be accepted for another. Verified signatures are
 * additionally bound to time and delivery: the platform timestamp must fall
 * inside a tolerance window, and each account/timestamp/nonce triple accepts
 * only byte-identical retries (bounded), so a captured plaintext-mode
 * signature cannot be replayed against a substituted body.
 */

import { createHash } from "node:crypto";
import type { Server } from "node:http";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { logger } from "@elizaos/core";
import {
  decryptCallbackPayload,
  verifyCallbackSignature,
} from "./callback-crypto";
import type {
  ResolvedWechatAccount,
  WechatMessageContext,
  WechatMessageType,
} from "./types";
import { WechatError } from "./types";
import { parseWechatXml } from "./xml";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
/** Public-internet binding: the platform must reach this listener. */
const CALLBACK_BIND_HOST = "0.0.0.0";

/**
 * Signature freshness window. WeChat's signature covers token/timestamp/nonce
 * (and, in encrypted mode, the ciphertext) but NOT the plaintext-mode body, so
 * without a freshness check a captured query authenticates any body forever.
 * Five minutes on either side of the wall clock comfortably covers platform
 * clock skew while making captured signatures worthless minutes later.
 */
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
/**
 * WeCom retries delivery (default 3 times) when a callback does not answer in
 * time, resending the identical payload and query. Byte-identical retries are
 * therefore legitimate; anything else under the same triple is tampering.
 */
const MAX_IDENTICAL_RETRIES = 3;
/**
 * Upper bound on tracked replay keys. Sized far above legitimate callback
 * volume within one freshness window (five minutes across every account) so
 * eviction never affects a live triple, while capping memory growth.
 */
const MAX_REPLAY_ENTRIES = 10_000;

/** Injectable per-run dependencies so tests can pin the clock. */
export interface CallbackServerClock {
  now: () => number;
}

class SignatureReplayGuard {
  private readonly seen = new Map<
    string,
    { bodySha256: string; retries: number; expiresAt: number }
  >();

  constructor(
    private readonly maxRetries: number,
    private readonly toleranceMs: number,
    private readonly clock: CallbackServerClock,
    private readonly maxEntries: number,
  ) {}

  /**
   * Returns true when the timestamp is inside the freshness window. A missing
   * or non-numeric timestamp was already rejected as 400 by the caller's
   * required-parameter check.
   */
  isFresh(timestamp: string): boolean {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) {
      return false;
    }
    const deltaMs = Math.abs(this.clock.now() - seconds * 1000);
    return deltaMs <= this.toleranceMs;
  }

  /**
   * Allows byte-identical redelivery (platform retry) and rejects a different
   * body replayed under a captured account/timestamp/nonce signature. An
   * entry lives exactly as long as its timestamp can still pass freshness
   * (expiry is keyed to the TIMESTAMP's freshness endpoint, not to receipt
   * time, so a future-skewed platform clock cannot leave a live window
   * unguarded), and the map is capped: at capacity new keys are rejected,
   * which can only fail closed (only signature-valid traffic ever inserts).
   */
  accepts(
    accountId: string,
    timestamp: string,
    nonce: string,
    bodySha256: string,
  ): boolean {
    const now = this.clock.now();
    // Lazy expiry sweep: drop every entry past its window before deciding.
    for (const [key, entry] of this.seen) {
      if (entry.expiresAt <= now) {
        this.seen.delete(key);
      }
    }
    const key = `${accountId}\n${timestamp}\n${nonce}`;
    const prior = this.seen.get(key);
    if (!prior) {
      if (this.seen.size >= this.maxEntries) {
        // Fail closed at capacity: never evict a still-live key, which would
        // re-admit an in-window replay.
        return false;
      }
      const seconds = Number(timestamp);
      this.seen.set(key, {
        bodySha256,
        retries: 0,
        expiresAt: seconds * 1000 + this.toleranceMs,
      });
      return true;
    }
    if (prior.bodySha256 === bodySha256 && prior.retries < this.maxRetries) {
      prior.retries += 1;
      return true;
    }
    return false;
  }
}

export interface CallbackServerOptions {
  port: number;
  accounts: ResolvedWechatAccount[];
  onMessage: (
    accountId: string,
    msg: WechatMessageContext,
  ) => void | Promise<void>;
  onDeliveryError?: (error: unknown, accountId: string) => void | Promise<void>;
  signal?: AbortSignal;
  maxBodyBytes?: number;
  /** Test seam: deterministic clock for freshness assertions. */
  clock?: CallbackServerClock;
}

export interface CallbackServerHandle {
  close: () => Promise<void>;
  port: number;
  host: string;
}

export async function startCallbackServer(
  options: CallbackServerOptions,
): Promise<CallbackServerHandle> {
  const {
    port,
    accounts,
    onMessage,
    onDeliveryError,
    signal,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    clock = { now: Date.now },
  } = options;
  const replayGuard = new SignatureReplayGuard(
    MAX_IDENTICAL_RETRIES,
    SIGNATURE_TOLERANCE_MS,
    clock,
    MAX_REPLAY_ENTRIES,
  );

  const server = createServer((req, res) => {
    // error-policy:J1 any unexpected failure inside request handling becomes
    // a structured 500 at this boundary instead of an unhandled rejection.
    handleRequest(req, res, {
      accounts,
      onMessage,
      onDeliveryError,
      maxBodyBytes,
      replayGuard,
    }).catch((error: unknown) => {
      logger.error(
        `[wechat] Unexpected callback handler failure: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(port, CALLBACK_BIND_HOST);
  });

  const address = server.address() as AddressInfo | null;
  const listeningPort = address?.port ?? port;

  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        void closeServer(server);
      },
      { once: true },
    );
  }

  return {
    close: () => closeServer(server),
    port: listeningPort,
    host: CALLBACK_BIND_HOST,
  };
}

interface RequestDeps {
  accounts: ResolvedWechatAccount[];
  onMessage: CallbackServerOptions["onMessage"];
  onDeliveryError: CallbackServerOptions["onDeliveryError"];
  maxBodyBytes: number;
  replayGuard: SignatureReplayGuard;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RequestDeps,
): Promise<void> {
  // Route-first: an unknown account/path is 404 regardless of method.
  const account = resolveCallbackAccount(req.url, deps.accounts);
  if (!account) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  const query = parseQuery(req.url ?? "");

  if (req.method === "GET") {
    handleUrlVerification(res, account, query, deps.replayGuard);
    return;
  }

  await handleMessagePost(req, res, account, query, deps);
}

function handleUrlVerification(
  res: ServerResponse,
  account: ResolvedWechatAccount,
  query: URLSearchParams,
  replayGuard: SignatureReplayGuard,
): void {
  // The verification flavor is fixed by the account's configured security
  // mode, not by which query parameters the caller happened to supply.
  const encryptedMode = account.securityMode === "encrypted";
  const signature = encryptedMode
    ? (query.get("msg_signature") ?? "")
    : (query.get("signature") ?? "");
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const echostr = query.get("echostr") ?? "";

  if (!signature || !timestamp || !nonce || !echostr) {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  const valid = verifyCallbackSignature(signature, [
    account.tokenSecret,
    timestamp,
    nonce,
    ...(encryptedMode ? [echostr] : []),
  ]);
  if (!valid || !replayGuard.isFresh(timestamp)) {
    // Signature failure or a stale signature is a security event: reject
    // without parsing anything.
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (encryptedMode) {
    try {
      const decrypted = decryptCallbackPayload(
        echostr,
        account.encodingAESKey ?? "",
      );
      if (!isBoundFramingReceiver(decrypted.receiverId, account)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(decrypted.plaintext);
      return;
    } catch (err) {
      if (err instanceof WechatError) {
        res.writeHead(400);
        res.end("Bad Request");
        return;
      }
      // error-policy:J1 only the typed expected decrypt failure is a 400;
      // anything unexpected propagates to the 500 boundary.
      throw err;
    }
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(echostr);
}

async function handleMessagePost(
  req: IncomingMessage,
  res: ServerResponse,
  account: ResolvedWechatAccount,
  query: URLSearchParams,
  deps: RequestDeps,
): Promise<void> {
  const encryptedMode = account.securityMode === "encrypted";
  const signature = encryptedMode
    ? (query.get("msg_signature") ?? "")
    : (query.get("signature") ?? "");
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  if (!signature || !timestamp || !nonce) {
    // For an encrypted-mode account `signature` is msg_signature, so an
    // encrypted payload arriving without it fails closed here (400) — it can
    // never fall through to the plaintext verification path below.
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  const body = await readBody(req, res, deps.maxBodyBytes);
  if (body === null) {
    return;
  }
  // Freshness and replay control on every verified delivery: a captured
  // signature goes stale within minutes, and a fresh triple only ever
  // redelivers byte-identical bodies (platform retry), never a substituted
  // one. Checked after the 400 shape gate but before signature work so an
  // attacker cannot use the check as an oracle.
  if (!deps.replayGuard.isFresh(timestamp)) {
    logger.warn(
      `[wechat] Rejecting stale callback signature for account "${account.id}"`,
    );
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  let xmlText: string;
  let envelopeAgentId: number | undefined;
  if (encryptedMode) {
    // WeCom's documented sequence: extract the outer Encrypt envelope with
    // the hardened parser, verify the signature over it, then decrypt. No
    // decrypted or business payload is parsed before verification succeeds.
    let envelope: { encrypt: string; outerAgentId?: number };
    try {
      envelope = extractEncryptedEnvelope(body.text);
    } catch (err) {
      // error-policy:J1 only the typed expected envelope failure is a 400;
      // anything unexpected propagates to the 500 boundary.
      if (err instanceof WechatError) {
        res.writeHead(400);
        res.end("Bad Request");
        return;
      }
      throw err;
    }
    const encryptField = envelope.encrypt;
    envelopeAgentId = envelope.outerAgentId;

    const valid = verifyCallbackSignature(signature, [
      account.tokenSecret,
      timestamp,
      nonce,
      encryptField,
    ]);
    if (!valid) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (
      !deps.replayGuard.accepts(account.id, timestamp, nonce, body.bodySha256)
    ) {
      // error-policy:J1 a replayed or substituted delivery under a captured
      // signature is a security rejection at this boundary.
      logger.warn(
        `[wechat] Rejecting replayed callback body for account "${account.id}"`,
      );
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    try {
      const decrypted = decryptCallbackPayload(
        encryptField,
        account.encodingAESKey ?? "",
      );
      if (!isBoundFramingReceiver(decrypted.receiverId, account)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      xmlText = decrypted.plaintext;
    } catch (err) {
      // error-policy:J1 only the typed expected decrypt failure is a 400;
      // anything unexpected propagates to the 500 boundary.
      if (err instanceof WechatError) {
        res.writeHead(400);
        res.end("Bad Request");
        return;
      }
      throw err;
    }
  } else {
    const valid = verifyCallbackSignature(signature, [
      account.tokenSecret,
      timestamp,
      nonce,
    ]);
    if (!valid) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (
      !deps.replayGuard.accepts(account.id, timestamp, nonce, body.bodySha256)
    ) {
      // error-policy:J1 the plaintext signature does not cover the body, so
      // replay state is the only thing binding this query to THIS delivery.
      logger.warn(
        `[wechat] Rejecting replayed callback body for account "${account.id}"`,
      );
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    xmlText = body.text;
  }

  let message: WechatMessageContext | null;
  try {
    message = normalizePlatformXml(xmlText, account);
  } catch (err) {
    if (!(err instanceof WechatError)) {
      // error-policy:J1 only the typed expected malformed-input failure is
      // acknowledged; a programmer/runtime failure propagates to the 500
      // boundary instead of being silently swallowed as a 200.
      throw err;
    }
    // error-policy:J3 unknown/malformed payload shapes are acknowledged so
    // the platform does not retry them; diagnostic reporting happened during
    // normalization.
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("success");
    return;
  }
  if (!message) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("success");
    return;
  }
  // Inner receiver binding: a decrypted/plaintext payload addressed to a
  // different account identity is a cross-account replay, not a message for
  // this route. Binding uses callbackIdentity (gh_ original ID / corpId) when
  // configured; an account WITH a configured identity requires a non-empty
  // ToUserName — an absent receiver cannot be verified and fails closed.
  // Unset identity (official-account without callbackId) skips binding rather
  // than mis-verifying against the appId.
  if (
    account.callbackIdentity &&
    (!message.recipient || !isBoundInnerReceiver(message.recipient, account))
  ) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  // WeCom evidence must belong to the configured agent. The outer envelope
  // AgentID is authoritative when present; the inner AgentID must agree with
  // both. An outer/inner disagreement or a mismatch with the configured agent
  // is a cross-agent replay under the same corp credentials. Malformed
  // values were already rejected during extraction/normalization.
  if (account.mode === "wecom" && account.wecomAgentId !== undefined) {
    const agentIds = [envelopeAgentId, message.agentId].filter(
      (id): id is number => id !== undefined,
    );
    if (
      agentIds.some((id) => id !== account.wecomAgentId) ||
      (envelopeAgentId !== undefined &&
        message.agentId !== undefined &&
        envelopeAgentId !== message.agentId)
    ) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
  }

  try {
    await deps.onMessage(account.id, message);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("success");
  } catch (error) {
    // error-policy:J1 the HTTP boundary returns a retryable server failure;
    // the runtime callback owns diagnostic reporting for the failed event.
    res.writeHead(500);
    res.end("Internal Server Error");
    const report = deps.onDeliveryError;
    if (report) {
      try {
        await report(error, account.id);
      } catch (diagnosticError) {
        // error-policy:J7 diagnostics must never escape the HTTP boundary or
        // replace the delivery failure that the 500 response represents.
        logger.error(
          `[wechat] Delivery error reporter failed: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`,
        );
      }
    }
  }
}

/**
 * Framing receiver binding: the AES payload trailer is the token-API identity
 * (appId for official accounts, corpId for WeCom) — always bound, never
 * skipped, because it is knowable from configuration alone.
 */
function isBoundFramingReceiver(
  observed: string,
  account: ResolvedWechatAccount,
): boolean {
  return observed === account.platformIdentity;
}

/**
 * Inner receiver binding: the business XML ToUserName is the corpId for WeCom
 * but the gh_ original ID (NOT the appId) for official accounts. WeCom always
 * binds (corpId); an official account binds only when `callbackId` names the
 * original ID — otherwise the check is skipped rather than mis-verified
 * against the appId.
 */
function isBoundInnerReceiver(
  observed: string,
  account: ResolvedWechatAccount,
): boolean {
  if (!account.callbackIdentity) {
    return account.mode === "official-account";
  }
  return observed === account.callbackIdentity;
}

/**
 * Parse the outer encrypted envelope: the Encrypt ciphertext plus, when the
 * platform carries it there, the envelope AgentID. WeCom self-built app
 * callbacks place AgentID in BOTH the outer envelope and the decrypted inner
 * XML; both surfaces are validated and must agree with the configured agent.
 */
function extractEncryptedEnvelope(body: string): {
  encrypt: string;
  outerAgentId?: number;
} {
  const parsed = parseWechatXml(body);
  const encrypt = parsed.fields.Encrypt;
  if (!encrypt) {
    throw new WechatError(
      "WECHAT_CALLBACK_MALFORMED",
      "encrypted callback has no Encrypt field",
    );
  }
  const rawAgentId = parsed.fields.AgentID;
  return {
    encrypt,
    outerAgentId: parseAgentIdField(rawAgentId),
  };
}

/**
 * A present AgentID must be a positive safe-integer decimal. Malformed,
 * unsafe, or non-positive values are a typed malformed-input failure — never
 * silently coerced to "absent", which would bypass agent binding.
 */
function parseAgentIdField(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new WechatError(
      "WECHAT_CALLBACK_MALFORMED",
      "AgentID is malformed or unsafe",
      { agentId: raw },
    );
  }
  return Number(raw);
}

/**
 * Normalize verified platform XML into the transport-independent inbound
 * message. Returns null for payloads that are legitimately not user messages
 * (unknown events); throws only on malformed structure, which the caller
 * treats as acknowledge-and-skip.
 */
export function normalizePlatformXml(
  xmlText: string,
  account: ResolvedWechatAccount,
): WechatMessageContext | null {
  const parsed = parseWechatXml(xmlText);
  const f = parsed.fields;

  const msgType = (f.MsgType ?? "").toLowerCase();
  const event = f.Event ? f.Event.toLowerCase() : undefined;
  const sender = f.FromUserName ?? "";
  const recipient = f.ToUserName ?? "";
  const rawTimestamp = Number(f.CreateTime ?? Number.NaN);
  if (!Number.isSafeInteger(rawTimestamp) || rawTimestamp < 0) {
    logger.warn("[wechat] Dropping callback with unusable CreateTime");
    return null;
  }
  // Platform CreateTime is epoch seconds.
  const timestamp = rawTimestamp * 1000;

  const id =
    f.MsgId ??
    (event
      ? `event-${sender}-${event}-${rawTimestamp}`
      : `msg-${sender}-${rawTimestamp}`);

  if (msgType === "event") {
    return {
      id,
      type: "event",
      sender,
      recipient,
      content: "",
      timestamp,
      threadId: undefined,
      group: undefined,
      event,
      // WeCom event callbacks carry the target agent too; surfaced for the
      // same agent binding as message callbacks. Malformed values are typed
      // malformed-input failures, never coerced to absent.
      agentId: parseAgentIdField(f.AgentID),
      platform: { mode: account.mode, accountId: account.id },
      raw: { root: parsed.root, event: f.Event ?? null },
    };
  }

  let type: WechatMessageType = "unknown";
  let content = "";
  let imageUrl: string | undefined;
  switch (msgType) {
    case "text":
      type = "text";
      content = f.Content ?? "";
      break;
    case "image":
      type = "image";
      imageUrl = f.PicUrl;
      break;
    case "voice":
      type = "voice";
      imageUrl = f.MediaId ? `media:${f.MediaId}` : undefined;
      break;
    case "video":
    case "shortvideo":
      type = "video";
      imageUrl = f.MediaId ? `media:${f.MediaId}` : undefined;
      break;
    case "file":
      type = "file";
      imageUrl = f.MediaId ? `media:${f.MediaId}` : undefined;
      break;
    default:
      logger.warn(`[wechat] Unknown callback MsgType: ${msgType}`);
      return null;
  }

  return {
    id,
    type,
    sender,
    recipient,
    content,
    timestamp,
    threadId: undefined,
    group: undefined,
    imageUrl,
    // WeCom app messages carry the target agent id; used for app binding.
    // Malformed values are typed malformed-input failures, never coerced.
    agentId: parseAgentIdField(f.AgentID),
    platform: { mode: account.mode, accountId: account.id },
    raw: { root: parsed.root, msgType },
  };
}

function resolveCallbackAccount(
  rawUrl: string | undefined,
  accounts: ResolvedWechatAccount[],
): ResolvedWechatAccount | null {
  if (!rawUrl) return null;
  try {
    const pathname = new URL(rawUrl, "http://localhost").pathname;
    const match = /^\/webhook\/wechat\/([^/]+)$/.exec(pathname);
    if (!match) return null;
    const accountId = safeDecode(match[1]);
    return accounts.find((a) => a.id === accountId) ?? null;
  } catch {
    // error-policy:J3 the request target is untrusted input; malformed
    // percent-encoding resolves to "no account" and a plain 404.
    return null;
  }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // error-policy:J3 the path segment is untrusted input; malformed
    // percent-encoding is surfaced as a typed invalid result so account
    // resolution fails closed (404), never a fabricated account id.
    throw new WechatError(
      "WECHAT_CALLBACK_MALFORMED",
      "webhook account id has malformed percent-encoding",
      { segment },
    );
  }
}

function parseQuery(rawUrl: string): URLSearchParams {
  try {
    return new URL(rawUrl, "http://localhost").searchParams;
  } catch {
    // error-policy:J3 an unparseable target yields empty query parameters;
    // signature checks then fail closed with 400/403.
    return new URLSearchParams();
  }
}

function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
): Promise<{ text: string; raw: Buffer; bodySha256: string } | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        // error-policy:J1 oversized request bodies are rejected at the
        // transport boundary before any parsing.
        res.writeHead(413);
        res.end("Payload Too Large");
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      // Byte identity is hashed from the ORIGINAL bytes, not a re-encoded
      // string: distinct invalid-UTF-8 sequences can normalize to the same
      // utf8 string, which would weaken the replay guard's identity check.
      const bodySha256 = createHash("sha256").update(raw).digest("hex");
      resolve({ text: raw.toString("utf8"), raw, bodySha256 });
    });
    req.on("error", () => {
      if (!res.writableEnded) {
        // error-policy:J1 a broken inbound request stream never enters
        // payload normalization or delivery.
        res.writeHead(400);
        res.end("Bad Request");
      }
      resolve(null);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
