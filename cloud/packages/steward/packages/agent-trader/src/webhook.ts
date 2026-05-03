/**
 * Webhook receiver.
 *
 * Listens for inbound HTTP POST events from Steward and dispatches them to
 * registered handlers.  The server uses Bun.serve when available, falling back
 * to Node's built-in `http` module.
 *
 * Supported event types (from @stwd/shared WebhookEvent):
 *   approval_required  — human review needed before tx proceeds
 *   tx_signed          — transaction was signed and broadcast
 *   tx_confirmed       — on-chain confirmation received
 *   tx_failed          — broadcast / confirmation failure
 *   tx_rejected        — policy or manual rejection
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebhookEvent } from "@stwd/shared";
import { logError, logInfo, logWebhook } from "./logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WebhookEventType = WebhookEvent["type"];

export type WebhookHandler = (event: WebhookEvent) => void | Promise<void>;

export interface WebhookServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: WebhookEventType | "*", handler: WebhookHandler): void;
}

// ─── Internal state ────────────────────────────────────────────────────────────

type HandlerMap = Map<string, WebhookHandler[]>;

type BunServeServer = {
  stop(): void | Promise<void>;
};

type BunServeRuntime = typeof globalThis & {
  Bun?: {
    serve(options: {
      port: number;
      fetch(req: Request): Response | Promise<Response>;
    }): BunServeServer;
  };
};

function buildHandlerMap(): HandlerMap {
  return new Map();
}

function addHandler(map: HandlerMap, event: string, handler: WebhookHandler): void {
  const list = map.get(event) ?? [];
  list.push(handler);
  map.set(event, list);
}

async function dispatchEvent(map: HandlerMap, event: WebhookEvent): Promise<void> {
  const specific = map.get(event.type) ?? [];
  const wildcard = map.get("*") ?? [];

  for (const handler of [...specific, ...wildcard]) {
    try {
      await handler(event);
    } catch (err) {
      logError("Webhook handler threw", err, { eventType: event.type });
    }
  }
}

// ─── Request parsing ──────────────────────────────────────────────────────────

async function parseBody(body: string): Promise<WebhookEvent | null> {
  try {
    const parsed = JSON.parse(body) as WebhookEvent;
    if (!parsed.type || !parsed.agentId) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createWebhookServer(port: number, _secret?: string): WebhookServer {
  const handlers = buildHandlerMap();
  let stopFn: (() => Promise<void>) | null = null;

  const handleRequest = async (body: string): Promise<{ status: number; message: string }> => {
    if (!body) {
      return { status: 400, message: "Empty body" };
    }

    const event = await parseBody(body);
    if (!event) {
      return { status: 400, message: "Invalid event payload" };
    }

    logWebhook({
      event: event.type,
      agentId: event.agentId,
      data: event.data,
    });

    await dispatchEvent(handlers, event);
    return { status: 200, message: "ok" };
  };

  return {
    on(event: WebhookEventType | "*", handler: WebhookHandler): void {
      addHandler(handlers, event, handler);
    },

    async start(): Promise<void> {
      // Try Bun.serve first (runtime available in bun)
      const bunRuntime = (globalThis as BunServeRuntime).Bun;
      if (bunRuntime) {
        const server = bunRuntime.serve({
          port,
          async fetch(req: Request) {
            if (req.method !== "POST") {
              return new Response("Method Not Allowed", { status: 405 });
            }
            const body = await req.text();
            const result = await handleRequest(body);
            return new Response(
              JSON.stringify({
                ok: result.status === 200,
                message: result.message,
              }),
              {
                status: result.status,
                headers: { "Content-Type": "application/json" },
              },
            );
          },
        });

        stopFn = async () => server.stop();
        logInfo(`Webhook server listening on port ${port} (Bun)`);
        return;
      }

      // Fallback: Node http
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const http = await import("node:http");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const srv = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end("Method Not Allowed");
          return;
        }

        let body = "";
        req.on("data", (chunk: { toString(): string }) => {
          body += chunk.toString();
        });
        req.on("end", async () => {
          const result = await handleRequest(body);
          res.writeHead(result.status, {
            "Content-Type": "application/json",
          });
          res.end(
            JSON.stringify({
              ok: result.status === 200,
              message: result.message,
            }),
          );
        });
      });

      await new Promise<void>((resolve) => srv.listen(port, resolve));
      stopFn = () =>
        new Promise<void>((resolve, reject) =>
          srv.close((err?: Error) => (err ? reject(err) : resolve())),
        );
      logInfo(`Webhook server listening on port ${port} (Node http)`);
    },

    async stop(): Promise<void> {
      if (stopFn) await stopFn();
      logInfo("Webhook server stopped");
    },
  };
}

// ─── Default handlers (wired up in loop.ts) ───────────────────────────────────

/**
 * Register standard logging handlers for all Steward event types.
 * Additional handlers (e.g. alerting, state adjustment) can be registered
 * separately with server.on(...).
 */
export function registerDefaultHandlers(server: WebhookServer): void {
  server.on("approval_required", (event) => {
    logInfo("⏳ Approval required — operator action needed", {
      agentId: event.agentId,
      data: event.data,
    });
  });

  server.on("tx_signed", (event) => {
    logInfo("✅ Transaction signed and broadcast", {
      agentId: event.agentId,
      txHash: event.data.txHash,
    });
  });

  server.on("tx_confirmed", (event) => {
    logInfo("⛓️  Transaction confirmed on-chain", {
      agentId: event.agentId,
      txHash: event.data.txHash,
      blockNumber: event.data.blockNumber,
    });
  });

  server.on("tx_failed", (event) => {
    logError("❌ Transaction failed", undefined, {
      agentId: event.agentId,
      data: event.data,
    });
  });

  server.on("tx_rejected", (event) => {
    logError("🚫 Transaction rejected by policy", undefined, {
      agentId: event.agentId,
      data: event.data,
    });
  });
}
