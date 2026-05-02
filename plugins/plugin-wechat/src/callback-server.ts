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
  onMessage: (accountId: string, msg: WechatMessageContext) => void;
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

    req.on("end", () => {
      if (res.writableEnded) {
        return;
      }

      try {
        const payload = JSON.parse(body) as Record<string, unknown>;
        const message = normalizePayload(payload);
        if (message) {
          onMessage(account.accountId, message);
        }
        res.writeHead(200);
        res.end("OK");
      } catch {
        res.writeHead(400);
        res.end("Bad Request");
      }
    });

    req.on("error", () => {
      if (res.writableEnded) {
        return;
      }

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

export function normalizePayload(
  payload: Record<string, unknown>,
): WechatMessageContext | null {
  // Support two payload formats: nested "raw" and flattened "proxy"
  const data =
    (payload.data as Record<string, unknown>) ??
    (payload.content ? payload : null);

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
  const timestamp = Number(data.timestamp ?? Date.now());
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
