import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Container live log stream (SSE) — Hetzner-Docker over SSH.
 *
 * Pipes `docker logs --follow` from the target node back to the client
 * as Server-Sent Events. The SSH channel is held open for the lifetime
 * of the SSE response; when the client disconnects, the AbortSignal
 * fires, the SSH channel closes, and the remote process exits via
 * SIGHUP.
 *
 * Format (one event per chunk):
 *   data: {"chunk":"...","stream":"stdout"}
 *
 * The `chunk` field may contain partial lines — clients should buffer.
 * Heartbeat comments (`: keep-alive`) are emitted every 25 seconds so
 * intermediaries don't time out idle connections.
 *
 * Auth: `requireAuthOrApiKeyWithOrg`. The container row is fetched with
 * the caller's organization_id, so cross-org access is impossible.
 */

import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  getHetznerContainersClient,
  HetznerClientError,
} from "@/lib/services/containers/hetzner-client";
import { logger } from "@/lib/utils/logger";

// Long-lived stream; cap matches the platform sidecar timeout. Most clients
// will disconnect first, which the AbortSignal handles cleanly.

const HEARTBEAT_INTERVAL_MS = 25_000;

async function __hono_GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let user: { organization_id: string | null };
  try {
    ({ user } = await requireAuthOrApiKeyWithOrg(request));
  } catch (err) {
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
  if (!user.organization_id) {
    return Response.json(
      { success: false, error: "Caller is not associated with an organization" },
      { status: 403 },
    );
  }
  const { id: containerId } = await params;
  const url = new URL(request.url);
  const tailLinesRaw = url.searchParams.get("tail");
  const tailLines = tailLinesRaw ? Number.parseInt(tailLinesRaw, 10) : 100;
  if (!Number.isInteger(tailLines) || tailLines < 0 || tailLines > 10_000) {
    return Response.json(
      { success: false, error: "tail must be an integer between 0 and 10000" },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const ac = new AbortController();
  // The browser disconnect signal is the canonical "stop streaming" trigger.
  if (request.signal) {
    if (request.signal.aborted) {
      ac.abort();
    } else {
      request.signal.addEventListener("abort", () => ac.abort(), { once: true });
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Controller already closed — ignore.
        }
      };
      const sendComment = (text: string) => {
        try {
          controller.enqueue(encoder.encode(`: ${text}\n\n`));
        } catch {
          /* closed */
        }
      };

      send("open", { containerId, tailLines });

      const heartbeat = setInterval(() => sendComment("keep-alive"), HEARTBEAT_INTERVAL_MS);

      try {
        await getHetznerContainersClient().streamLogs(containerId, user.organization_id!, {
          tailLines,
          signal: ac.signal,
          onStdout: (chunk) => send("log", { chunk, stream: "stdout" }),
          onStderr: (chunk) => send("log", { chunk, stream: "stderr" }),
        });
        send("close", { reason: "remote_exit" });
      } catch (err) {
        if (err instanceof HetznerClientError) {
          send("error", { code: err.code, message: err.message });
        } else {
          logger.error("[containers/logs/stream] failed", {
            containerId,
            error: err instanceof Error ? err.message : String(err),
          });
          send("error", {
            code: "stream_failed",
            message: err instanceof Error ? err.message : "stream failed",
          });
        }
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      ac.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
