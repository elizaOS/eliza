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

type WorkflowDefinitionPayload = {
  id?: string;
  name: string;
  nodes: unknown[];
  connections: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

type WorkflowServiceLike = {
  listWorkflows: (userId?: string) => Promise<unknown[]>;
  getWorkflow: (workflowId: string) => Promise<unknown>;
  deployWorkflow: (workflow: WorkflowDefinitionPayload, userId: string) => Promise<unknown>;
  generateWorkflowDraft: (
    prompt: string,
    opts?: { userId?: string },
  ) => Promise<WorkflowDefinitionPayload>;
  activateWorkflow: (workflowId: string) => Promise<void>;
  deactivateWorkflow: (workflowId: string) => Promise<void>;
  deleteWorkflow: (workflowId: string) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asWorkflow(value: unknown): WorkflowDefinitionPayload | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.name !== "string" ||
    !Array.isArray(value.nodes) ||
    !isRecord(value.connections)
  ) {
    return null;
  }
  return value as WorkflowDefinitionPayload;
}

function readUserId(headers: HeaderMap, body?: unknown): string {
  if (isRecord(body) && typeof body.userId === "string" && body.userId.trim()) {
    return body.userId.trim();
  }
  const headerUserId = headers["x-eliza-user-id"] ?? headers["X-Eliza-User-Id"];
  return headerUserId?.trim() || "cloud";
}

function readWorkflowBody(
  body: unknown,
): { workflow: WorkflowDefinitionPayload; activate?: boolean } | null {
  const record = isRecord(body) ? body : {};
  const workflow = asWorkflow(record.workflow) ?? asWorkflow(record);
  if (!workflow) return null;
  return {
    workflow,
    activate: typeof record.activate === "boolean" ? record.activate : undefined,
  };
}

async function withWorkflowService<T>(
  manager: AgentManager,
  agentId: string,
  set: { status?: number | string },
  fn: (service: WorkflowServiceLike) => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await manager.useRuntime(agentId, async (runtime) => {
      const service = runtime.getService?.("workflow") as WorkflowServiceLike | null | undefined;
      if (!service) {
        set.status = 503;
        return { error: "workflow service unavailable" };
      }
      return await fn(service);
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    set.status = message === "Agent not found" || message === "Agent not running" ? 404 : 500;
    return { error: message };
  }
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
 *   /agents/:id/workflows/*   - Manage in-process p1p3s workflows for the agent runtime
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

    .get("/agents/:id/workflows/status", async ({ params, headers, set }) => {
      const denial = requireInternalAuth(headers as HeaderMap, set, sharedSecret);
      if (denial) return denial;

      return await manager.useRuntime(params.id, async (runtime) => {
        const service = runtime.getService?.("workflow");
        return {
          mode: service ? "local" : "disabled",
          host: "in-process",
          status: service ? "ready" : "error",
          cloudConnected: true,
          localEnabled: Boolean(service),
          platform: "cloud",
          cloudHealth: "ok",
          errorMessage: service ? null : "Workflow service is not registered",
        };
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        set.status = message === "Agent not found" || message === "Agent not running" ? 404 : 500;
        return { error: message };
      });
    })

    .get("/agents/:id/workflows", async ({ params, headers, set }) => {
      const headerMap = headers as HeaderMap;
      const denial = requireInternalAuth(headerMap, set, sharedSecret);
      if (denial) return denial;

      return await withWorkflowService(manager, params.id, set, async (service) => ({
        workflows: await service.listWorkflows(readUserId(headerMap)),
      }));
    })

    .post("/agents/:id/workflows", async ({ params, body, headers, set }) => {
      const headerMap = headers as HeaderMap;
      const denial = requireInternalAuth(headerMap, set, sharedSecret);
      if (denial) return denial;

      const payload = readWorkflowBody(body);
      if (!payload) {
        set.status = 400;
        return { error: "workflow payload required" };
      }

      return await withWorkflowService(manager, params.id, set, async (service) => {
        const deployed = await service.deployWorkflow(payload.workflow, readUserId(headerMap, body));
        const deployedRecord = isRecord(deployed) ? deployed : {};
        const deployedId = typeof deployedRecord.id === "string" ? deployedRecord.id : undefined;
        if (payload.activate === false && deployedId && deployedRecord.active === true) {
          await service.deactivateWorkflow(deployedId);
        }
        return deployedId ? await service.getWorkflow(deployedId) : deployed;
      });
    })

    .post("/agents/:id/workflows/generate", async ({ params, body, headers, set }) => {
      const headerMap = headers as HeaderMap;
      const denial = requireInternalAuth(headerMap, set, sharedSecret);
      if (denial) return denial;
      if (!isRecord(body)) {
        set.status = 400;
        return { error: "request body required" };
      }

      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) {
        set.status = 400;
        return { error: "prompt required" };
      }

      return await withWorkflowService(manager, params.id, set, async (service) => {
        const userId = readUserId(headerMap, body);
        const draft = await service.generateWorkflowDraft(prompt, { userId });
        if (typeof body.name === "string" && body.name.trim()) {
          draft.name = body.name.trim();
        }
        if (typeof body.workflowId === "string" && body.workflowId.trim()) {
          draft.id = body.workflowId.trim();
        }

        const clarifications = Array.isArray(draft._meta?.requiresClarification)
          ? draft._meta.requiresClarification
          : [];
        if (clarifications.length > 0) {
          return { status: "needs_clarification", draft, clarifications, catalog: [] };
        }

        const deployed = await service.deployWorkflow(draft, userId);
        const deployedRecord = isRecord(deployed) ? deployed : {};
        const deployedId = typeof deployedRecord.id === "string" ? deployedRecord.id : undefined;
        return deployedId ? await service.getWorkflow(deployedId) : deployed;
      });
    })

    .get("/agents/:id/workflows/:workflowId", async ({ params, headers, set }) => {
      const denial = requireInternalAuth(headers as HeaderMap, set, sharedSecret);
      if (denial) return denial;
      return await withWorkflowService(manager, params.id, set, async (service) =>
        service.getWorkflow(params.workflowId),
      );
    })

    .put("/agents/:id/workflows/:workflowId", async ({ params, body, headers, set }) => {
      const headerMap = headers as HeaderMap;
      const denial = requireInternalAuth(headerMap, set, sharedSecret);
      if (denial) return denial;

      const payload = readWorkflowBody(body);
      if (!payload) {
        set.status = 400;
        return { error: "workflow payload required" };
      }

      return await withWorkflowService(manager, params.id, set, async (service) => {
        const deployed = await service.deployWorkflow(
          { ...payload.workflow, id: params.workflowId },
          readUserId(headerMap, body),
        );
        const deployedRecord = isRecord(deployed) ? deployed : {};
        const deployedId = typeof deployedRecord.id === "string" ? deployedRecord.id : undefined;
        if (payload.activate === false && deployedId && deployedRecord.active === true) {
          await service.deactivateWorkflow(deployedId);
        }
        return deployedId ? await service.getWorkflow(deployedId) : deployed;
      });
    })

    .delete("/agents/:id/workflows/:workflowId", async ({ params, headers, set }) => {
      const denial = requireInternalAuth(headers as HeaderMap, set, sharedSecret);
      if (denial) return denial;
      return await withWorkflowService(manager, params.id, set, async (service) => {
        await service.deleteWorkflow(params.workflowId);
        return { ok: true };
      });
    })

    .post("/agents/:id/workflows/:workflowId/activate", async ({ params, headers, set }) => {
      const denial = requireInternalAuth(headers as HeaderMap, set, sharedSecret);
      if (denial) return denial;
      return await withWorkflowService(manager, params.id, set, async (service) => {
        await service.activateWorkflow(params.workflowId);
        return await service.getWorkflow(params.workflowId);
      });
    })

    .post("/agents/:id/workflows/:workflowId/deactivate", async ({ params, headers, set }) => {
      const denial = requireInternalAuth(headers as HeaderMap, set, sharedSecret);
      if (denial) return denial;
      return await withWorkflowService(manager, params.id, set, async (service) => {
        await service.deactivateWorkflow(params.workflowId);
        return await service.getWorkflow(params.workflowId);
      });
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
