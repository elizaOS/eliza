import { Elysia } from "elysia";
import type { AgentManager } from "./agent-manager";
import { EventBodySchema } from "./handlers/event";
import { logger } from "./logger";

type HeaderMap = Record<string, string | undefined>;

/**
 * Extracts the auth token from request headers.
 * Checks X-Server-Token first, then falls back to Authorization Bearer.
 */
function getAuthToken(headers: HeaderMap): string | null {
  const direct = headers["x-server-token"] ?? headers["X-Server-Token"];
  if (direct) {
    return direct.trim();
  }

  const authorization = headers.authorization ?? headers.Authorization;
  if (authorization && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return null;
}

/**
 * Validates internal service-to-service auth.
 * Returns null on success, or an error response object with the appropriate
 * HTTP status set when auth fails (401) or is unconfigured (503).
 */
function requireInternalAuth(
  headers: HeaderMap,
  set: { status?: number | string },
  sharedSecret: string,
) {
  if (!sharedSecret) {
    set.status = 503;
    return { error: "Server auth not configured" };
  }

  if (getAuthToken(headers) !== sharedSecret) {
    set.status = 401;
    return { error: "Unauthorized" };
  }

  return null;
}

/**
 * Creates the Elysia route tree for the agent-server.
 *
 * Routes:
 *   GET  /health              - Liveness probe
 *   GET  /ready               - Readiness probe (503 while draining)
 *   GET  /status              - Server status (auth required)
 *   POST /agents              - Start a new agent (auth required)
 *   POST /agents/:id/stop     - Stop an agent (auth required)
 *   DELETE /agents/:id        - Delete an agent (auth required)
 *   POST /agents/:id/message  - Forward a user message to an agent (auth required)
 *   POST /agents/:id/event    - Forward a structured event to an agent (auth required, ticket #54)
 *   POST /drain               - Initiate graceful drain (auth required)
 */
export function createRoutes(manager: AgentManager, sharedSecret: string) {
  return new Elysia()
    .get("/health", () => ({ alive: true }))

    .get("/ready", ({ set }) => {
      if (manager.isDraining()) {
        set.status = 503;
        return { ready: false };
      }
      return { ready: true };
    })

    .get("/status", ({ headers, set }) => {
      const denial = requireInternalAuth(headers as HeaderMap, set, sharedSecret);
      if (denial) {
        return denial;
      }
      return manager.getStatus();
    })

    .post("/agents", async ({ body, headers, set }) => {
      const denial = requireInternalAuth(headers as HeaderMap, set, sharedSecret);
      if (denial) {
        return denial;
      }
      const { agentId, characterRef } = body as {
        agentId: string;
        characterRef: string;
      };
      if (!agentId || !characterRef) {
        set.status = 400;
        return { error: "agentId and characterRef are required" };
      }
      try {
        await manager.startAgent(agentId, characterRef);
        set.status = 201;
        return { agentId, status: "running" };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        set.status = message === "At capacity" ? 503 : 409;
        return { error: message };
      }
    })

    .post("/agents/:id/stop", async ({ params, headers, set }) => {
      const denial = requireInternalAuth(headers as HeaderMap, set, sharedSecret);
      if (denial) {
        return denial;
      }
      try {
        await manager.stopAgent(params.id);
        return { agentId: params.id, status: "stopped" };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        set.status = 404;
        return { error: message };
      }
    })

    .delete("/agents/:id", async ({ params, headers, set }) => {
      const denial = requireInternalAuth(headers as HeaderMap, set, sharedSecret);
      if (denial) {
        return denial;
      }
      try {
        await manager.deleteAgent(params.id);
        return { agentId: params.id, deleted: true };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        set.status = 404;
        return { error: message };
      }
    })

    .post("/agents/:id/message", async ({ params, body, headers, set }) => {
      const denial = requireInternalAuth(headers as HeaderMap, set, sharedSecret);
      if (denial) {
        return denial;
      }
      const raw = body as Record<string, unknown>;
      const userId = typeof raw.userId === "string" ? raw.userId : undefined;
      const text = typeof raw.text === "string" ? raw.text : undefined;
      if (!userId || !text) {
        set.status = 400;
        return { error: "userId and text are required" };
      }

      const platformName = typeof raw.platformName === "string" ? raw.platformName : undefined;
      const senderName = typeof raw.senderName === "string" ? raw.senderName : undefined;
      const chatId = typeof raw.chatId === "string" ? raw.chatId : undefined;

      // Keeps metadata undefined (not {}) when no fields present,
      // so handleMessage's gated debug log doesn't fire on plain requests.
      const metadata =
        platformName || senderName || chatId
          ? {
              ...(platformName && { platformName }),
              ...(senderName && { senderName }),
              ...(chatId && { chatId }),
            }
          : undefined;

      try {
        const response = await manager.handleMessage(params.id, userId, text, metadata);
        return { response };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        set.status = message === "Agent not found" || message === "Agent not running" ? 404 : 500;
        return { error: message };
      }
    })

    .post("/agents/:id/event", async ({ params, body, headers, set }) => {
      const denial = requireInternalAuth(headers as HeaderMap, set, sharedSecret);
      if (denial) {
        return denial;
      }

      if (manager.isDraining()) {
        set.status = 503;
        return { error: "Server is draining" };
      }

      const parsed = EventBodySchema.safeParse(body);
      if (!parsed.success) {
        logger.warn("Event rejected: schema validation failed", {
          agentId: params.id,
          issues: parsed.error.issues,
        });
        set.status = 400;
        return { error: "invalid request body", details: parsed.error.issues };
      }

      try {
        const result = await manager.handleEvent(
          params.id,
          parsed.data.userId,
          parsed.data.type,
          parsed.data.payload,
        );
        return { handled: true, type: parsed.data.type, ...result };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "Agent not found" || message === "Agent not running") {
          set.status = 404;
        } else {
          logger.error("Event handler failed", {
            agentId: params.id,
            type: parsed.data.type,
            error: message,
          });
          set.status = 500;
        }
        return { error: message };
      }
    })

    .post("/drain", async ({ headers, set }) => {
      const denial = requireInternalAuth(headers as HeaderMap, set, sharedSecret);
      if (denial) {
        return denial;
      }
      await manager.drain();
      await manager.cleanupRedis();
      return { drained: true };
    });
}
