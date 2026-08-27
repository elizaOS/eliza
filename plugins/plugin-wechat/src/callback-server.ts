/**
 * Public callback HTTP surface for first-party WeChat platforms: `GET` URL
 * verification (echo/echostr handshake) and `POST` message delivery. Every
 * request is signature-verified against the addressed account before any
 * parsing, decryption, or dispatch; unverified requests never reach message
 * normalization or the runtime. Accounts are addressed by id in the path
 * (`/webhook/wechat/<accountId>`), so one server serves many accounts and a
 * signed-for-A payload can never be replayed against account B. This module
 * replaces the deleted proxy callback protocol wholesale.
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
    onDeliveryError = () => undefined,
    signal,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  } = options;

  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      accounts,
      onMessage,
      onDeliveryError,
      maxBodyBytes,
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
  const account = resolveCallbackAccount(req.url, deps.accounts);
  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }
  if (!account) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const query = parseQuery(req.url ?? "");

  if (req.method === "GET") {
    handleUrlVerification(req, res, account, query);
    return;
  }

  await handleMessagePost(req, res, account, query, deps);
}

function handleUrlVerification(
  _req: IncomingMessage,
  res: ServerResponse,
  account: ResolvedWechatAccount,
  query: URLSearchParams,
): void {
  const signature = query.get("signature") ?? query.get("msg_signature") ?? "";
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const echostr = query.get("echostr") ?? "";

  if (!signature || !timestamp || !nonce || !echostr) {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  const encryptedEcho = query.get("msg_signature") !== null;
  const valid = verifyCallbackSignature(signature, [
    account.tokenSecret,
    timestamp,
    nonce,
    encryptedEcho ? echostr : undefined,
  ]);
  if (!valid) {
    // Signature failure is a security event: reject without parsing anything.
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (encryptedEcho) {
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
  const signature = query.get("msg_signature") ?? query.get("signature") ?? "";
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  if (!signature || !timestamp || !nonce) {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  const body = await readBody(req, res, deps.maxBodyBytes);
  if (body === null) {
    return;
  }

  const encrypted =
    query.get("msg_signature") !== null || body.includes("<Encrypt>");
  let encryptField: string | undefined;
  if (encrypted) {
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
  }

  let xmlText: string;
  if (encrypted) {
    const valid = verifyCallbackSignature(signature, [
      account.tokenSecret,
      timestamp,
      nonce,
      encryptField ?? "",
    ]);
    if (!valid) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    try {
      const decrypted = decryptCallbackPayload(
        encryptField ?? "",
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

  // WeCom app chat may address a group via ChatId in some forms; Official
  // Account has no group scope. Room scoping arrives only with observed data.
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
