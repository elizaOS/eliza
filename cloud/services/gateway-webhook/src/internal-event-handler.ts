import { z } from "zod";
import { validateInternalSecret } from "./internal-auth";
import { logger } from "./logger";
import {
  forwardEventToServer,
  type RoutingRedis,
  refreshKedaActivity,
  resolveAgentServer,
} from "./server-router";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Zod schema for the internal event request body.
 * K8s services (CronJobs, matcher, notifier) send events matching this shape.
 */
const InternalEventSchema = z.object({
  agentId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
  // Allows periods and @ for email-format userIds (e.g. user@domain.com)
  userId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9_@.-]+$/),
  type: z.enum(["cron", "notification", "system"]),
  // Depth/fan-out is not validated — callers are trusted K8s-internal services
  // (CronJobs, matcher, notifier) that have already passed X-Internal-Secret auth.
  // The 64KB byte-length guard bounds total size.
  payload: z.record(z.string(), z.unknown()),
});

export type InternalEvent = z.infer<typeof InternalEventSchema>;

interface InternalEventDeps {
  redis: RoutingRedis;
}

/**
 * Handles an incoming internal event request from K8s services.
 *
 * Synchronous phase: validates auth and body, returns 200 immediately.
 * Async phase: resolves agent server, refreshes KEDA, forwards event
 * to the agent pod (fire-and-forget).
 */
export async function handleInternalEvent(
  request: Request,
  deps: InternalEventDeps,
): Promise<Response> {
  if (!validateInternalSecret(request)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const clHeader = request.headers.get("content-length");
  const contentLength = clHeader !== null ? Number(clHeader) : null;
  if (contentLength !== null && Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    logger.warn("Internal event rejected: payload too large (content-length)", {
      contentLength,
    });
    return jsonResponse({ error: "payload too large" }, 413);
  }

  let rawText: string;
  try {
    rawText = await request.text();
  } catch (error) {
    logger.warn("Internal event rejected: unreadable body", {
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({ error: "invalid request" }, 400);
  }

  if (Buffer.byteLength(rawText) > MAX_BODY_BYTES) {
    logger.warn("Internal event rejected: payload too large", {
      bytes: Buffer.byteLength(rawText),
    });
    return jsonResponse({ error: "payload too large" }, 413);
  }

  let rawBody: unknown;
  try {
    rawBody = JSON.parse(rawText);
  } catch {
    logger.warn("Internal event rejected: malformed JSON body");
    return jsonResponse({ error: "invalid JSON" }, 400);
  }

  const parsed = InternalEventSchema.safeParse(rawBody);
  if (!parsed.success) {
    logger.warn("Internal event rejected: schema validation failed", {
      issues: parsed.error.issues,
    });
    return jsonResponse({ error: "invalid request body", details: parsed.error.issues }, 400);
  }

  const event = parsed.data;
  logger.info("Internal event queued", {
    agentId: event.agentId,
    type: event.type,
  });

  processInternalEvent(event, deps).catch((err) => {
    logger.error("Background internal event processing failed", {
      error: err instanceof Error ? err.message : String(err),
      agentId: event.agentId,
      type: event.type,
    });
  });

  return jsonResponse({ queued: true }, 200);
}

/**
 * Background processing for an internal event: resolve agent server,
 * refresh KEDA activity, and forward the event to the agent pod.
 *
 * There is no dead-letter queue: if the agent server cannot be resolved
 * or forwarding fails after retries, the event is logged and dropped.
 * Monitor the "No server found for agent" (warn) and "Forward event
 * to server failed" (error) log lines as the primary signal for
 * missed deliveries.
 */
async function processInternalEvent(event: InternalEvent, deps: InternalEventDeps): Promise<void> {
  const { redis } = deps;

  const server = await resolveAgentServer(redis, event.agentId);
  if (!server) {
    // warn, not error: expected during rolling updates or for unregistered agents
    logger.warn("No server found for agent", { agentId: event.agentId });
    return;
  }

  // refreshKedaActivity writes to the `keda:{serverName}:activity` trigger list
  // (used by KEDA ScaledObject to decide replica count). It is fully independent
  // of hash-ring routing, which resolves pod IPs via headless service DNS.
  // Safe to detach — a failure here does not affect event forwarding.
  refreshKedaActivity(redis, server.serverName).catch((err) => {
    logger.warn("refreshKedaActivity failed", {
      serverName: server.serverName,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  try {
    await forwardEventToServer(
      server.serverUrl,
      server.serverName,
      event.agentId,
      event.userId,
      event.type,
      event.payload,
    );
  } catch (err) {
    logger.error("Forward event to server failed", {
      error: err instanceof Error ? err.message : String(err),
      agentId: event.agentId,
      type: event.type,
    });
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
