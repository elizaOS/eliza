/**
 * Local HTTP webhook server that receives inbound messages POSTed by the WeChat
 * proxy service, authenticates them (constant-time token compare), and
 * normalizes the raw proxy payloads into `WechatMessageContext` for the bot.
 * `WECHAT_TYPE_MAP` translates the proxy's numeric message types into the
 * plugin's message-type + private/group scope.
 */
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { WechatMessageContext, WechatMessageType } from "./types";

const WECHAT_TYPE_MAP: Record<
  number,
  { type: WechatMessageType; scope: "private" | "group" }
> = {
  // Private message types
  60001: { type: "text", scope: "private" },
  60002: { type: "image", scope: "private" },
  60003: { type: "voice", scope: "private" },
  60004: { type: "video", scope: "private" },
  60005: { type: "file", scope: "private" },
  // Group message types
  80001: { type: "text", scope: "group" },
  80002: { type: "image", scope: "group" },
  80003: { type: "voice", scope: "group" },
  80004: { type: "video", scope: "group" },
  80005: { type: "file", scope: "group" },
};

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export interface CallbackServerOptions {
  port: number;
  accounts: Array<{ accountId: string; apiKey: string }>;
  onMessage: (
    accountId: string,
    msg: WechatMessageContext,
  ) => void | Promise<void>;
  onDeliveryError: (error: unknown, accountId: string) => void;
  signal?: AbortSignal;
  maxBodyBytes?: number;
}

export async function startCallbackServer(
  options: CallbackServerOptions,
): Promise<{
  close: () => Promise<void>;
  port: number;
}> {
  const {
    port,
    accounts,
    onMessage,
    onDeliveryError,
    signal,
    maxBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
  } = options;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const account = resolveWebhookAccount(req.url, accounts);
    if (req.method !== "POST" || !account) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const incomingKey = readHeaderValue(req.headers["x-api-key"]);
    if (!incomingKey || !safeCompare(incomingKey, account.apiKey)) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }

    let body = "";
    let bodyBytes = 0;
    req.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > maxBodyBytes) {
        res.writeHead(413);
        res.end("Payload Too Large");
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on("end", async () => {
      if (res.writableEnded) {
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        // error-policy:J1 malformed JSON is translated at the HTTP boundary;
        // delivery failures are handled separately below and must never be
        // mislabeled as invalid client input.
        res.writeHead(400);
        res.end("Bad Request");
        return;
      }

      const message = normalizePayload(payload);
      if (!message) {
        res.writeHead(200);
        res.end("OK");
        return;
      }

      try {
        await onMessage(account.accountId, message);
      } catch (error) {
        // error-policy:J1 the HTTP boundary returns a retryable server failure;
        // the runtime callback owns diagnostic reporting for the failed event.
        res.writeHead(500);
        res.end("Internal Server Error");
        onDeliveryError(error, account.accountId);
        return;
      }

      res.writeHead(200);
      res.end("OK");
    });

    req.on("error", () => {
      if (res.writableEnded) {
        return;
      }

      // error-policy:J1 a broken inbound request stream is translated at the
      // transport boundary and never enters payload normalization or delivery.
      res.writeHead(400);
      res.end("Bad Request");
    });
  });

  await new Promise<void>((resolve, reject) => {
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };
    const handleError = (error: Error) => {
      server.off("listening", handleListening);
      reject(error);
    };

    server.once("listening", handleListening);
    server.once("error", handleError);
    server.listen(port);
  });

  const address = server.address() as AddressInfo | null;
  const listeningPort = address?.port ?? port;
  console.log(`[wechat] Webhook server listening on port ${listeningPort}`);

  server.on("error", (err: Error) => {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(
        `[wechat] Port ${listeningPort} already in use — webhook server failed to start`,
      );
    } else {
      console.error(`[wechat] Webhook server error:`, err);
    }
  });

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
  };
}

function resolveWebhookAccount(
  rawUrl: string | undefined,
  accounts: Array<{ accountId: string; apiKey: string }>,
) {
  if (!rawUrl) {
    return null;
  }

  try {
    const pathname = new URL(rawUrl, "http://localhost").pathname;
    if (pathname === "/webhook/wechat" && accounts.length === 1) {
      return accounts[0];
    }

    const match = /^\/webhook\/wechat\/([^/]+)$/.exec(pathname);
    if (!match) {
      return null;
    }

    const accountId = decodeURIComponent(match[1]);
    return accounts.find((account) => account.accountId === accountId) ?? null;
  } catch {
    // error-policy:J3 the request target is untrusted input: a lone "%" or
    // "%ZZ" account segment makes decodeURIComponent throw URIError, which
    // would otherwise escape the synchronous request handler and kill the
    // server. Malformed targets resolve to "no account" so the caller
    // answers a plain 404.
    return null;
  }
}

function readHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against itself to burn constant time, then return false
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizePayload(
  payload: unknown,
): WechatMessageContext | null {
  if (!isRecord(payload)) {
    return null;
  }

  // Support two payload formats: nested "raw" and flattened "proxy". The
  // nested form must actually be a plain object — a string/array/scalar
  // `data` field is an unrecognized payload, not a message.
  const hasNestedData = Object.hasOwn(payload, "data");
  const data = hasNestedData
    ? isRecord(payload.data)
      ? payload.data
      : null
    : payload.content
      ? payload
      : null;

  if (!data) {
    console.warn("[wechat] Unrecognized webhook payload format");
    return null;
  }

  const typeCode = Number(data.type ?? data.msgType ?? 0);
  const mapping = WECHAT_TYPE_MAP[typeCode];

  let msgType: WechatMessageType = "unknown";
  let scope: "private" | "group" = "private";

  if (mapping) {
    msgType = mapping.type;
    scope = mapping.scope;
  } else if (typeCode >= 60006 && typeCode <= 60010) {
    // Unmapped private media — treat as file
    msgType = "file";
    scope = "private";
  } else if (typeCode >= 80006 && typeCode <= 80010) {
    // Unmapped group media — treat as file
    msgType = "file";
    scope = "group";
  }

  if (msgType === "unknown") {
    console.warn(`[wechat] Unknown message type code: ${typeCode}`);
    return null;
  }

  const sender = String(data.sender ?? data.from ?? "");
  const recipient = String(data.recipient ?? data.to ?? "");
  const content = String(data.content ?? data.text ?? "");
  // A genuinely absent timestamp means "received now"; a present but
  // unusable one fails the whole message closed so a non-finite or negative
  // value can never become the inbound Memory's createdAt (#19060, matching
  // the plugin-x policy from #18965).
  const hasTimestamp = Object.hasOwn(data, "timestamp");
  const rawTimestamp = data.timestamp;
  const timestamp = hasTimestamp
    ? normalizeWebhookTimestamp(rawTimestamp)
    : Date.now();
  if (timestamp === null) {
    console.warn(
      `[wechat] Dropping webhook message with unusable timestamp: ${String(rawTimestamp)}`,
    );
    return null;
  }
  const msgId = String(data.msgId ?? data.id ?? `${sender}-${timestamp}`);

  // Group detection
  const isGroup = scope === "group" || sender.includes("@chatroom");
  const threadId = isGroup
    ? String(data.roomId ?? data.threadId ?? sender)
    : undefined;
  const groupSubject = isGroup
    ? String(data.roomName ?? data.groupName ?? threadId ?? "")
    : undefined;

  // Media URL extraction (images, voice, video, files)
  const mediaTypes = new Set(["image", "voice", "video", "file"]);
  const hasMedia = mediaTypes.has(msgType);
  const imageUrl = hasMedia
    ? String(data.imageUrl ?? data.mediaUrl ?? data.url ?? data.fileUrl ?? "")
    : undefined;

  return {
    id: msgId,
    type: msgType,
    sender,
    recipient,
    content,
    timestamp,
    threadId,
    group: groupSubject ? { subject: groupSubject } : undefined,
    imageUrl: imageUrl || undefined,
    raw: payload,
  };
}

function normalizeWebhookTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    return null;
  }
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}
