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
 * for one account can never be accepted for another.
 */
import type { Server } from "node:http";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
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
  } = options;

  const server = createServer((req, res) => {
    // error-policy:J1 any unexpected failure inside request handling becomes
    // a structured 500 at this boundary instead of an unhandled rejection.
    handleRequest(req, res, {
      accounts,
      onMessage,
      onDeliveryError,
      maxBodyBytes,
    }).catch((error: unknown) => {
      console.error("[wechat] Unexpected callback handler failure", {
        error: error instanceof Error ? error.message : String(error),
      });
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
    handleUrlVerification(res, account, query);
    return;
  }

  await handleMessagePost(req, res, account, query, deps);
}

function handleUrlVerification(
  res: ServerResponse,
  account: ResolvedWechatAccount,
  query: URLSearchParams,
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
  if (!valid) {
    // Signature failure is a security event: reject without parsing anything.
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
      if (decrypted.receiverId !== account.platformIdentity) {
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
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }
  if (encryptedMode && query.get("msg_signature") === null) {
    // An encrypted-mode account must never accept the plaintext path.
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const body = await readBody(req, res, deps.maxBodyBytes);
  if (body === null) {
    return;
  }

  let xmlText: string;
  if (encryptedMode) {
    // WeCom's documented sequence: extract the outer Encrypt envelope with
    // the hardened parser, verify the signature over it, then decrypt. No
    // decrypted or business payload is parsed before verification succeeds.
    let encryptField: string;
    try {
      encryptField = extractEncryptField(body);
    } catch (err) {
      if (err instanceof WechatError) {
        res.writeHead(400);
        res.end("Bad Request");
        return;
      }
      throw err;
    }

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
    try {
      const decrypted = decryptCallbackPayload(
        encryptField,
        account.encodingAESKey ?? "",
      );
      if (decrypted.receiverId !== account.platformIdentity) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      xmlText = decrypted.plaintext;
    } catch (err) {
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
    xmlText = body;
  }

  let message: WechatMessageContext | null;
  try {
    message = normalizePlatformXml(xmlText, account);
  } catch {
    // Unknown/malformed payload shapes are acknowledged so the platform does
    // not retry them; diagnostic reporting happened during normalization.
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("success");
    return;
  }
  if (!message) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("success");
    return;
  }
  // Receiver binding: a decrypted/plaintext payload addressed to a different
  // account identity is a cross-account replay, not a message for this route.
  if (message.recipient && message.recipient !== account.platformIdentity) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
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
        console.error("[wechat] Delivery error reporter failed", {
          error:
            diagnosticError instanceof Error
              ? diagnosticError.message
              : String(diagnosticError),
        });
      }
    }
  }
}

function extractEncryptField(body: string): string {
  const parsed = parseWechatXml(body);
  const encrypt = parsed.fields.Encrypt;
  if (!encrypt) {
    throw new WechatError(
      "WECHAT_CALLBACK_MALFORMED",
      "encrypted callback has no Encrypt field",
    );
  }
  return encrypt;
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
    console.warn("[wechat] Dropping callback with unusable CreateTime");
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
      console.warn(`[wechat] Unknown callback MsgType: ${msgType}`);
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
    throw new URIError("malformed percent-encoding");
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
): Promise<string | null> {
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
      resolve(Buffer.concat(chunks).toString("utf8"));
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
