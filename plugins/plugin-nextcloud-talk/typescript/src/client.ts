import { createHmac, randomBytes } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { createServer } from "node:http";
import type {
  NextcloudTalkInboundMessage,
  NextcloudTalkSendOptions,
  NextcloudTalkSendResult,
  NextcloudTalkWebhookHeaders,
  NextcloudTalkWebhookPayload,
  NextcloudTalkWebhookServerOptions,
} from "./types";

// Header names
const SIGNATURE_HEADER = "x-nextcloud-talk-signature";
const RANDOM_HEADER = "x-nextcloud-talk-random";
const BACKEND_HEADER = "x-nextcloud-talk-backend";

/**
 * Verify the HMAC-SHA256 signature of an incoming webhook request.
 * Signature is calculated as: HMAC-SHA256(random + body, secret)
 */
export function verifySignature(params: {
  signature: string;
  random: string;
  body: string;
  secret: string;
}): boolean {
  const { signature, random, body, secret } = params;
  if (!signature || !random || !secret) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(random + body)
    .digest("hex");

  if (signature.length !== expected.length) {
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Extract webhook headers from an incoming request.
 */
export function extractWebhookHeaders(
  headers: Record<string, string | string[] | undefined>
): NextcloudTalkWebhookHeaders | null {
  const getHeader = (name: string): string | undefined => {
    const value = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };

  const signature = getHeader(SIGNATURE_HEADER);
  const random = getHeader(RANDOM_HEADER);
  const backend = getHeader(BACKEND_HEADER);

  if (!signature || !random || !backend) {
    return null;
  }

  return { signature, random, backend };
}

/**
 * Generate signature headers for an outbound request to Nextcloud Talk.
 */
export function generateSignature(params: { body: string; secret: string }): {
  random: string;
  signature: string;
} {
  const { body, secret } = params;
  const random = randomBytes(32).toString("hex");
  const signature = createHmac("sha256", secret)
    .update(random + body)
    .digest("hex");
  return { random, signature };
}

/**
 * Send a message to a Nextcloud Talk room.
 */
export async function sendMessage(
  opts: NextcloudTalkSendOptions
): Promise<NextcloudTalkSendResult> {
  const { baseUrl, secret, roomToken, message, replyTo } = opts;

  if (!message?.trim()) {
    throw new Error("Message must be non-empty for Nextcloud Talk sends");
  }

  const body: Record<string, unknown> = { message: message.trim() };
  if (replyTo) {
    body.replyTo = replyTo;
  }
  const bodyStr = JSON.stringify(body);

  const { random, signature } = generateSignature({ body: bodyStr, secret });

  const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${roomToken}/message`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OCS-APIRequest": "true",
      "X-Nextcloud-Talk-Bot-Random": random,
      "X-Nextcloud-Talk-Bot-Signature": signature,
    },
    body: bodyStr,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    const status = response.status;
    let errorMsg = `Nextcloud Talk send failed (${status})`;

    if (status === 400) {
      errorMsg = `Nextcloud Talk: bad request - ${errorBody || "invalid message format"}`;
    } else if (status === 401) {
      errorMsg = "Nextcloud Talk: authentication failed - check bot secret";
    } else if (status === 403) {
      errorMsg = "Nextcloud Talk: forbidden - bot may not have permission in this room";
    } else if (status === 404) {
      errorMsg = `Nextcloud Talk: room not found (token=${roomToken})`;
    } else if (errorBody) {
      errorMsg = `Nextcloud Talk send failed: ${errorBody}`;
    }

    throw new Error(errorMsg);
  }

  let messageId = "unknown";
  let timestamp: number | undefined;
  try {
    const data = (await response.json()) as {
      ocs?: {
        data?: {
          id?: number | string;
          timestamp?: number;
        };
      };
    };
    if (data.ocs?.data?.id != null) {
      messageId = String(data.ocs.data.id);
    }
    if (typeof data.ocs?.data?.timestamp === "number") {
      timestamp = data.ocs.data.timestamp;
    }
  } catch {
    // Response parsing failed, but message was sent.
  }

  return { messageId, roomToken, timestamp };
}

/**
 * Send a reaction to a message in Nextcloud Talk.
 */
export async function sendReaction(opts: {
  baseUrl: string;
  secret: string;
  roomToken: string;
  messageId: string;
  reaction: string;
}): Promise<{ ok: true }> {
  const { baseUrl, secret, roomToken, messageId, reaction } = opts;

  const body = JSON.stringify({ reaction });
  const { random, signature } = generateSignature({ body, secret });

  const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${roomToken}/reaction/${messageId}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OCS-APIRequest": "true",
      "X-Nextcloud-Talk-Bot-Random": random,
      "X-Nextcloud-Talk-Bot-Signature": signature,
    },
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Nextcloud Talk reaction failed: ${response.status} ${errorBody}`.trim());
  }

  return { ok: true };
}

/**
 * Parse the webhook payload into an inbound message.
 */
export function parseWebhookPayload(
  payload: NextcloudTalkWebhookPayload
): NextcloudTalkInboundMessage {
  return {
    messageId: payload.object.id,
    roomToken: payload.target.id,
    roomName: payload.target.name,
    senderId: payload.actor.id,
    senderName: payload.actor.name,
    text: payload.object.content,
    mediaType: payload.object.mediaType,
    timestamp: Date.now(),
    // Heuristic: rooms with > 1 participant are usually group chats
    // The actual determination should be made by querying the room info
    isGroupChat: false, // Will be set by service based on room info
  };
}

/**
 * Create and start a webhook server for receiving Nextcloud Talk messages.
 */
export function createWebhookServer(opts: NextcloudTalkWebhookServerOptions): HttpServer {
  const { port, host, path, secret, onMessage, onError } = opts;

  const server = createServer(async (req, res) => {
    // Only accept POST requests to the webhook path
    if (req.method !== "POST" || req.url !== path) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    try {
      // Read the request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const bodyStr = Buffer.concat(chunks).toString("utf-8");

      // Extract and verify headers
      const headers = extractWebhookHeaders(
        req.headers as Record<string, string | string[] | undefined>
      );
      if (!headers) {
        res.writeHead(400);
        res.end("Missing required headers");
        return;
      }

      // Verify signature
      if (!verifySignature({ ...headers, body: bodyStr, secret })) {
        res.writeHead(401);
        res.end("Invalid signature");
        return;
      }

      // Parse payload
      const payload = JSON.parse(bodyStr) as NextcloudTalkWebhookPayload;

      // Only handle "Create" events (new messages)
      if (payload.type !== "Create") {
        res.writeHead(200);
        res.end("OK");
        return;
      }

      // Parse and deliver the message
      const message = parseWebhookPayload(payload);
      await onMessage(message);

      res.writeHead(200);
      res.end("OK");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      onError?.(err);
      res.writeHead(500);
      res.end("Internal server error");
    }
  });

  server.listen(port, host);

  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => {
      server.close();
    });
  }

  return server;
}
