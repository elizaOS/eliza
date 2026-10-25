/**
 * Mock Blooio provider + outbound capture for the group-room simulation.
 *
 * The webhook gateway hardcodes https://api.blooio.com for its outbound
 * sends, typing indicators and read receipts. gateway-fetch-tap.preload.ts
 * redirects those calls here. This server records every request verbatim to
 * a JSONL outbox, answers message sends with a provider-shaped receipt (so
 * sendReplyWithReceipt sees a durable message id) and accepts everything
 * else, then serves the outbox back in the exact shape run-room-sim.ts's
 * OUTBOUND_CAPTURE contract needs.
 *
 * Routes:
 *   POST /v4/messages                 recorded; {id} receipt (DM sends: `to`)
 *   POST /v4/chats/:chatId/messages   recorded; {id} receipt (group sends)
 *   anything else under /v4, /v2      recorded; {ok:true} (typing, read)
 *   GET  /_capture                    normalized outbound message sends as
 *                                     [{text, chat_id, direction:"outbound"}]
 *                                     -> point OUTBOUND_CAPTURE here
 *   GET  /_outbox                     the raw JSONL outbox
 *
 * Env:
 *   PORT             listen port (default 48810)
 *   ROOM_SIM_OUTBOX  outbox path (default results/blooio-outbox.jsonl next
 *                    to this file; results/ is gitignored)
 *
 * Run: bun packages/cloud/scripts/group-room-sim/mock-blooio-provider.ts
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MOCK_BLOOIO_PORT = 48810;
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTBOX_PATH = join(HERE, "results", "blooio-outbox.jsonl");

export interface OutboxEntry {
  n: number;
  at: string;
  method: string;
  path: string;
  headers: Record<string, string | null>;
  body: string | null;
}

export interface CapturedSend {
  text: string;
  chat_id: string;
  direction: "outbound";
}

const MESSAGE_SEND_PATH = /^\/v4\/chats\/([^/]+)\/messages$/;

/** True for the two v4 routes that deliver a message (and earn a receipt). */
export function isMessageSend(method: string, path: string): boolean {
  return (
    method === "POST" &&
    (path === "/v4/messages" || MESSAGE_SEND_PATH.test(path))
  );
}

/**
 * Pure shape translation from the raw outbox to the driver's capture
 * contract: only real outbound message sends, each tagged with its chat id
 * (from the URL for chat sends, from `to` for v4 /messages). Typing, read and
 * capture-read noise is dropped. No filtering, rewriting or dedup of message
 * text beyond extracting it.
 */
export function captureFromOutbox(jsonl: string): CapturedSend[] {
  const out: CapturedSend[] = [];
  for (const [index, line] of jsonl.split("\n").entries()) {
    if (!line.trim()) continue;
    let entry: Partial<OutboxEntry>;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      // error-policy:J3 untrusted-input sanitizing: capture corruption is a
      // harness error, never silently converted into apparent model silence.
      throw new Error(`corrupt mock Blooio outbox JSON at line ${index + 1}`, {
        cause: error,
      });
    }
    if (entry.method !== "POST" || typeof entry.path !== "string") continue;
    let parsedBody: Record<string, unknown> = {};
    if (typeof entry.body === "string") {
      try {
        parsedBody = JSON.parse(entry.body);
      } catch (error) {
        if (isMessageSend(entry.method, entry.path)) {
          // error-policy:J3 untrusted-input sanitizing: a corrupt message-send
          // body could hide model output, so the capture must fail closed.
          throw new Error(
            `corrupt mock Blooio message body at line ${index + 1}`,
            {
              cause: error,
            },
          );
        }
      }
    }
    let chat: string | undefined;
    const chatPath = entry.path.match(MESSAGE_SEND_PATH);
    if (chatPath) {
      chat = decodeURIComponent(chatPath[1]);
    } else if (entry.path === "/v4/messages") {
      if (typeof parsedBody.to === "string") chat = parsedBody.to;
    } else {
      continue; // typing indicators, read receipts, etc.
    }
    const text = typeof parsedBody.text === "string" ? parsedBody.text : "";
    if (!text || !chat) continue;
    out.push({ text, chat_id: chat, direction: "outbound" });
  }
  return out;
}

function startMockBlooioProvider(options: {
  port: number;
  outboxPath: string;
}): ReturnType<typeof Bun.serve> {
  const { port, outboxPath } = options;
  mkdirSync(dirname(outboxPath), { recursive: true });
  let seq = 0;
  const readOutbox = () =>
    existsSync(outboxPath) ? readFileSync(outboxPath, "utf8") : "";

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/_capture") {
        return Response.json(captureFromOutbox(readOutbox()));
      }
      if (req.method === "GET" && url.pathname === "/_outbox") {
        return new Response(readOutbox(), {
          headers: { "content-type": "application/x-ndjson" },
        });
      }

      const body = await req.text();
      const entry: OutboxEntry = {
        n: ++seq,
        at: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        headers: {
          authorization: req.headers.has("authorization") ? "[REDACTED]" : null,
          "idempotency-key": req.headers.has("idempotency-key")
            ? "[REDACTED]"
            : null,
          "x-from-number": req.headers.get("x-from-number"),
        },
        body: body || null,
      };
      appendFileSync(outboxPath, `${JSON.stringify(entry)}\n`);

      if (isMessageSend(req.method, url.pathname)) {
        return Response.json({ id: `mock_blooio_msg_${seq}` });
      }
      return Response.json({ ok: true });
    },
  });
}

if (import.meta.main) {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: direct CLI env documented in README, outside Turbo tasks
  const port = Number(process.env.PORT ?? DEFAULT_MOCK_BLOOIO_PORT);
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: direct CLI env documented in README, outside Turbo tasks
  const outboxPath = process.env.ROOM_SIM_OUTBOX ?? DEFAULT_OUTBOX_PATH;
  startMockBlooioProvider({ port, outboxPath });
  console.log(
    `[mock-blooio-provider] listening on http://127.0.0.1:${port} (capture: /_capture) -> ${outboxPath}`,
  );
}
