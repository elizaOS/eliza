/**
 * Defines the authenticated control and workflow HTTP boundary for hosted
 * agent containers. Workflow operations derive their owner only from trusted
 * internal headers and return typed, non-enumerating errors across tenants.
 */
import { ElizaError } from "@elizaos/core";
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
  if (authorization?.toLowerCase().startsWith("bearer ")) {
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
  description?: string;
  source: string;
  language: "tsx" | "typescript";
  active?: boolean;
  inputSchema?: Record<string, unknown>;
  steps?: unknown[];
  widgets?: unknown[];
  schedule?: Record<string, unknown>;
};

type WorkflowServiceLike = {
  listWorkflows: (userId: string) => Promise<unknown[]>;
  getWorkflow: (workflowId: string, userId: string) => Promise<unknown>;
  deployWorkflow: (
    workflow: WorkflowDefinitionPayload,
    userId: string,
    options?: { activate?: boolean },
  ) => Promise<unknown>;
  generateWorkflowDraft: (
    prompt: string,
    opts?: { userId?: string },
  ) => Promise<WorkflowDefinitionPayload>;
  activateWorkflow: (workflowId: string, userId: string) => Promise<void>;
  deactivateWorkflow: (workflowId: string, userId: string) => Promise<void>;
  deleteWorkflow: (workflowId: string, userId: string) => Promise<void>;
  startWorkflow: (
    workflowId: string,
    options: { mode?: "manual"; input?: Record<string, unknown> } | undefined,
    userId: string,
  ) => Promise<unknown>;
  listExecutions: (
    params: { workflowId?: string; limit?: number },
    userId: string,
  ) => Promise<{ data: unknown[]; nextCursor?: string }>;
  getExecutionDetail: (executionId: string, userId: string) => Promise<unknown>;
  cancelExecution: (executionId: string, userId: string) => Promise<unknown>;
  decideApproval: (
    executionId: string,
    nodeId: string,
    iteration: number,
    approved: boolean,
    options?: { note?: string; decidedBy?: string; decision?: unknown },
  ) => Promise<unknown>;
  signalExecution: (
    executionId: string,
    signal: string,
    payload: unknown,
    receivedBy?: string,
  ) => Promise<unknown>;
  getWorkflowRevisions: (
    workflowId: string,
    limit: number | undefined,
    userId: string,
  ) => Promise<unknown[]>;
  restoreWorkflowRevision: (
    workflowId: string,
    versionId: string,
    userId: string,
  ) => Promise<unknown>;
  getWorkflowEvaluationSuite: (
    workflowId: string,
    limit: number | undefined,
    userId: string,
  ) => Promise<unknown>;
};

type WorkflowRuntimeLike = {
  getService?: (serviceType: string) => unknown;
};

type WorkflowErrorResponse = {
  success: false;
  code: string;
  error: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asWorkflow(value: unknown): WorkflowDefinitionPayload | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.name !== "string" ||
    typeof value.source !== "string" ||
    (value.language !== "tsx" && value.language !== "typescript") ||
    (value.id !== undefined && typeof value.id !== "string")
  ) {
    return null;
  }
  return value as WorkflowDefinitionPayload;
}

function requireWorkflowPrincipal(
  headers: HeaderMap,
  set: { status?: number | string },
): string | WorkflowErrorResponse {
  const headerUserId = headers["x-eliza-user-id"] ?? headers["X-Eliza-User-Id"];
  const userId = headerUserId?.trim();
  if (userId) return userId;

  set.status = 401;
  return {
    success: false,
    code: "workflow_principal_required",
    error: "Workflow user principal is required",
  };
}

function workflowRecordId(workflow: unknown): string | null {
  if (!isRecord(workflow) || typeof workflow.id !== "string") return null;
  const id = workflow.id.trim();
  return id || null;
}

function workflowRouteError(
  status: number,
  code: string,
  message: string,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    cause,
    context: { workflowHttpStatus: status },
    severity: status >= 500 ? "fatal" : "ephemeral",
  });
}

async function userOwnsWorkflow(
  service: WorkflowServiceLike,
  userId: string,
  workflowId: string,
): Promise<boolean> {
  const workflows = await service.listWorkflows(userId);
  return workflows.some(
    (workflow) => workflowRecordId(workflow) === workflowId,
  );
}

async function requireWorkflowOwnership(
  service: WorkflowServiceLike,
  userId: string,
  workflowId: string,
  persistenceRequired = false,
): Promise<void> {
  if (await userOwnsWorkflow(service, userId, workflowId)) return;

  if (persistenceRequired) {
    throw workflowRouteError(
      500,
      "workflow_ownership_not_persisted",
      "Workflow ownership could not be persisted",
    );
  }

  // Missing and foreign workflows intentionally share one response so this
  // boundary never becomes an ownership oracle.
  throw workflowRouteError(404, "workflow_not_found", "Workflow not found");
}

function errorStatusCode(error: unknown): number | null {
  return isRecord(error) && typeof error.statusCode === "number"
    ? error.statusCode
    : null;
}

async function getOwnedExecution(
  service: WorkflowServiceLike,
  userId: string,
  executionId: string,
): Promise<unknown> {
  let execution: unknown;
  try {
    execution = await service.getExecutionDetail(executionId, userId);
  } catch (error) {
    // error-policy:J2 preserve a known upstream 404 while adding the public
    // no-oracle execution classification used by this boundary.
    if (errorStatusCode(error) === 404) {
      throw workflowRouteError(
        404,
        "workflow_execution_not_found",
        "Workflow execution not found",
        error,
      );
    }
    throw error;
  }

  if (
    !isRecord(execution) ||
    typeof execution.workflowId !== "string" ||
    !execution.workflowId.trim()
  ) {
    throw workflowRouteError(
      500,
      "workflow_execution_invalid",
      "Workflow execution is missing its workflow owner",
    );
  }
  if (!(await userOwnsWorkflow(service, userId, execution.workflowId.trim()))) {
    throw workflowRouteError(
      404,
      "workflow_execution_not_found",
      "Workflow execution not found",
    );
  }
  return execution;
}

function boundedLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  return Math.min(Math.max(1, parsed || fallback), 50);
}

async function getOwnedWorkflow(
  service: WorkflowServiceLike,
  userId: string,
  workflowId: string,
): Promise<unknown> {
  await requireWorkflowOwnership(service, userId, workflowId);
  return service.getWorkflow(workflowId, userId);
}

function workflowActiveState(workflow: unknown): boolean {
  if (isRecord(workflow) && typeof workflow.active === "boolean") {
    return workflow.active;
  }
  throw workflowRouteError(
    500,
    "workflow_active_state_invalid",
    "Workflow is missing its activation state",
  );
}

async function compensateUnownedDeployment(
  service: WorkflowServiceLike,
  userId: string,
  workflowId: string,
): Promise<void> {
  try {
    await requireWorkflowOwnership(service, userId, workflowId, true);
  } catch (error) {
    // error-policy:J6 remove the newly-created orphan before rethrowing the
    // original ownership failure; cleanup failure must not fabricate success.
    try {
      await service.deleteWorkflow(workflowId, userId);
    } catch (cleanupError) {
      // error-policy:J6 ownership compensation is best-effort; the original
      // persistence failure remains the response while cleanup is observable.
      logger.error("Failed to remove a workflow with no persisted owner", {
        workflowId,
        cleanupError,
      });
    }
    throw error;
  }
}

async function finalizeWorkflowDeployment(params: {
  service: WorkflowServiceLike;
  userId: string;
  deployed: unknown;
  requestedWorkflowId: string | null;
  active: boolean;
}): Promise<unknown> {
  const deployedId = workflowRecordId(params.deployed);
  if (!deployedId) {
    throw workflowRouteError(
      500,
      "workflow_deployment_id_missing",
      "Workflow deployment returned no verifiable workflow id",
    );
  }

  const created = deployedId !== params.requestedWorkflowId;
  if (created) {
    await compensateUnownedDeployment(
      params.service,
      params.userId,
      deployedId,
    );
  } else {
    await requireWorkflowOwnership(params.service, params.userId, deployedId);
  }

  const deployedWorkflow = await params.service.getWorkflow(
    deployedId,
    params.userId,
  );
  const deployedActive = workflowActiveState(deployedWorkflow);
  if (deployedActive !== params.active) {
    if (params.active) {
      await params.service.activateWorkflow(deployedId, params.userId);
    } else {
      await params.service.deactivateWorkflow(deployedId, params.userId);
    }
  }
  return params.service.getWorkflow(deployedId, params.userId);
}

function readWorkflowBody(
  body: unknown,
): { workflow: WorkflowDefinitionPayload; activate?: boolean } | null {
  const record = isRecord(body) ? body : {};
  const workflow = asWorkflow(record.workflow) ?? asWorkflow(record);
  if (!workflow) return null;
  return {
    workflow,
    activate:
      typeof record.activate === "boolean" ? record.activate : undefined,
  };
}

async function withWorkflowService<T>(
  manager: AgentManager,
  agentId: string,
  set: { status?: number | string },
  fn: (
    service: WorkflowServiceLike,
    runtime: WorkflowRuntimeLike,
  ) => Promise<T>,
): Promise<T | WorkflowErrorResponse> {
  try {
    return await manager.useRuntime(agentId, async (runtime) => {
      const service = runtime.getService?.("workflow") as
        | WorkflowServiceLike
        | null
        | undefined;
      if (!service) {
        set.status = 503;
        return {
          success: false,
          code: "workflow_service_unavailable",
          error: "Workflow service is unavailable",
        };
      }
      return await fn(service, runtime);
    });
  } catch (err: unknown) {
    // error-policy:J1 this is the HTTP boundary for workflow service failures.
    const workflowHttpStatus =
      err instanceof ElizaError &&
      typeof err.context?.workflowHttpStatus === "number"
        ? err.context.workflowHttpStatus
        : null;
    if (workflowHttpStatus !== null && err instanceof ElizaError) {
      set.status = workflowHttpStatus;
      return { success: false, code: err.code, error: err.message };
    }

    const message = err instanceof Error ? err.message : String(err);
    const agentUnavailable =
      message === "Agent not found" || message === "Agent not running";
    set.status = agentUnavailable ? 404 : 500;
    return {
      success: false,
      code: agentUnavailable ? "agent_not_found" : "workflow_operation_failed",
      error: message,
    };
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
 *   /agents/:id/workflows/*   - Manage in-process workflows workflows for the agent runtime
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
      const denial = requireInternalAuth(
        headers as HeaderMap,
        set,
        sharedSecret,
      );
      if (denial) {
        return denial;
      }
      return manager.getStatus();
    })

    .post("/agents", async ({ body, headers, set }) => {
      const denial = requireInternalAuth(
        headers as HeaderMap,
        set,
        sharedSecret,
      );
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
        // error-policy:J1 translate the agent-server HTTP boundary into an explicit status.
        const message = err instanceof Error ? err.message : String(err);
        set.status = message === "At capacity" ? 503 : 409;
        return { error: message };
      }
    })

    .post("/agents/:id/stop", async ({ params, headers, set }) => {
      const denial = requireInternalAuth(
        headers as HeaderMap,
        set,
        sharedSecret,
      );
      if (denial) {
        return denial;
      }
      try {
        await manager.stopAgent(params.id);
        return { agentId: params.id, status: "stopped" };
      } catch (err: unknown) {
        // error-policy:J1 translate the agent-server HTTP boundary into an explicit status.
        const message = err instanceof Error ? err.message : String(err);
        set.status = 404;
        return { error: message };
      }
    })

    .delete("/agents/:id", async ({ params, headers, set }) => {
      const denial = requireInternalAuth(
        headers as HeaderMap,
        set,
        sharedSecret,
      );
      if (denial) {
        return denial;
      }
      try {
        await manager.deleteAgent(params.id);
        return { agentId: params.id, deleted: true };
      } catch (err: unknown) {
        // error-policy:J1 translate the agent-server HTTP boundary into an explicit status.
        const message = err instanceof Error ? err.message : String(err);
        set.status = 404;
        return { error: message };
      }
    })

    .post("/agents/:id/message", async ({ params, body, headers, set }) => {
      const denial = requireInternalAuth(
        headers as HeaderMap,
        set,
        sharedSecret,
      );
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

      const platformName =
        typeof raw.platformName === "string" ? raw.platformName : undefined;
      const senderName =
        typeof raw.senderName === "string" ? raw.senderName : undefined;
      const chatId = typeof raw.chatId === "string" ? raw.chatId : undefined;
      const accountId =
        typeof raw.accountId === "string" ? raw.accountId : undefined;
      const platformRecordId =
        typeof raw.platformRecordId === "string"
          ? raw.platformRecordId
          : undefined;
      const chatType =
        typeof raw.chatType === "string" ? raw.chatType : undefined;

      // Keeps metadata undefined (not {}) when no fields present,
      // so handleMessage's gated debug log doesn't fire on plain requests.
      const metadata =
        platformName ||
        senderName ||
        chatId ||
        accountId ||
        platformRecordId ||
        chatType
          ? {
              ...(platformName && { platformName }),
              ...(senderName && { senderName }),
              ...(chatId && { chatId }),
              ...(accountId && { accountId }),
              ...(platformRecordId && { platformRecordId }),
              ...(chatType && { chatType }),
            }
          : undefined;

      try {
        const response = await manager.handleMessage(
          params.id,
          userId,
          text,
          metadata,
        );
        return { response };
      } catch (err: unknown) {
        // error-policy:J1 translate the agent-server HTTP boundary into an explicit status.
        const message = err instanceof Error ? err.message : String(err);
        set.status =
          message === "Agent not found" || message === "Agent not running"
            ? 404
            : 500;
        return { error: message };
      }
    })

    .post("/agents/:id/event", async ({ params, body, headers, set }) => {
      const denial = requireInternalAuth(
        headers as HeaderMap,
        set,
        sharedSecret,
      );
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
        // error-policy:J1 translate the agent-server HTTP boundary into an explicit status.
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
      const denial = requireInternalAuth(
        headers as HeaderMap,
        set,
        sharedSecret,
      );
      if (denial) return denial;

      return await manager
        .useRuntime(params.id, async (runtime) => {
          const service = runtime.getService?.("workflow");
          return {
            mode: service ? "cloud" : "disabled",
            host: service ? "eliza-cloud" : null,
            status: service ? "ready" : "error",
            cloudConnected: true,
            localEnabled: false,
            platform: "cloud",
            cloudHealth: service ? "healthy" : "unknown",
            engine: "smthrs",
            errorMessage: service ? null : "Workflow service is not registered",
          };
        })
        .catch((err: unknown) => {
          // error-policy:J1 translate the workflow-status HTTP boundary into an explicit status.
          const message = err instanceof Error ? err.message : String(err);
          set.status =
            message === "Agent not found" || message === "Agent not running"
              ? 404
              : 500;
          return { error: message };
        });
    })

    .get("/agents/:id/workflows", async ({ params, headers, set }) => {
      const headerMap = headers as HeaderMap;
      const denial = requireInternalAuth(headerMap, set, sharedSecret);
      if (denial) return denial;
      const userId = requireWorkflowPrincipal(headerMap, set);
      if (typeof userId !== "string") return userId;

      return await withWorkflowService(
        manager,
        params.id,
        set,
        async (service) => ({
          workflows: await service.listWorkflows(userId),
        }),
      );
    })

    .post("/agents/:id/workflows", async ({ params, body, headers, set }) => {
      const headerMap = headers as HeaderMap;
      const denial = requireInternalAuth(headerMap, set, sharedSecret);
      if (denial) return denial;
      const userId = requireWorkflowPrincipal(headerMap, set);
      if (typeof userId !== "string") return userId;

      const payload = readWorkflowBody(body);
      if (!payload) {
        set.status = 400;
        return { error: "workflow payload required" };
      }

      return await withWorkflowService(
        manager,
        params.id,
        set,
        async (service) => {
          const requestedWorkflowId = payload.workflow.id?.trim() || null;
          let desiredActive = payload.activate ?? false;
          if (requestedWorkflowId) {
            const previousActive = workflowActiveState(
              await getOwnedWorkflow(service, userId, requestedWorkflowId),
            );
            desiredActive = payload.activate ?? previousActive;
          }
          const deployed = await service.deployWorkflow(
            {
              ...payload.workflow,
              id: requestedWorkflowId ?? undefined,
            },
            userId,
            { activate: payload.activate },
          );
          return finalizeWorkflowDeployment({
            service,
            userId,
            deployed,
            requestedWorkflowId,
            active: desiredActive,
          });
        },
      );
    })

    .post(
      "/agents/:id/workflows/generate",
      async ({ params, body, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;
        if (!isRecord(body)) {
          set.status = 400;
          return { error: "request body required" };
        }

        const prompt =
          typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) {
          set.status = 400;
          return { error: "prompt required" };
        }

        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) => {
            const draft = await service.generateWorkflowDraft(prompt, {
              userId,
            });
            if (typeof body.name === "string" && body.name.trim()) {
              draft.name = body.name.trim();
            }
            return { workflow: draft };
          },
        );
      },
    )

    .get(
      "/agents/:id/workflows/:workflowId",
      async ({ params, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;
        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) =>
            getOwnedWorkflow(service, userId, params.workflowId),
        );
      },
    )

    .put(
      "/agents/:id/workflows/:workflowId",
      async ({ params, body, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;

        const payload = readWorkflowBody(body);
        if (!payload) {
          set.status = 400;
          return { error: "workflow payload required" };
        }

        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) => {
            const previousActive = workflowActiveState(
              await getOwnedWorkflow(service, userId, params.workflowId),
            );
            const desiredActive = payload.activate ?? previousActive;
            const deployed = await service.deployWorkflow(
              { ...payload.workflow, id: params.workflowId },
              userId,
              { activate: payload.activate },
            );
            return finalizeWorkflowDeployment({
              service,
              userId,
              deployed,
              requestedWorkflowId: params.workflowId,
              active: desiredActive,
            });
          },
        );
      },
    )

    .delete(
      "/agents/:id/workflows/:workflowId",
      async ({ params, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;
        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) => {
            await requireWorkflowOwnership(service, userId, params.workflowId);
            await service.deleteWorkflow(params.workflowId, userId);
            return { ok: true };
          },
        );
      },
    )

    .post(
      "/agents/:id/workflows/:workflowId/activate",
      async ({ params, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;
        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) => {
            await requireWorkflowOwnership(service, userId, params.workflowId);
            await service.activateWorkflow(params.workflowId, userId);
            return await service.getWorkflow(params.workflowId, userId);
          },
        );
      },
    )

    .post(
      "/agents/:id/workflows/:workflowId/deactivate",
      async ({ params, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;
        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) => {
            await requireWorkflowOwnership(service, userId, params.workflowId);
            await service.deactivateWorkflow(params.workflowId, userId);
            return await service.getWorkflow(params.workflowId, userId);
          },
        );
      },
    )

    .post(
      "/agents/:id/workflows/:workflowId/run",
      async ({ params, body, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;

        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) => {
            await requireWorkflowOwnership(service, userId, params.workflowId);
            const execution = await service.startWorkflow(
              params.workflowId,
              {
                mode: "manual",
                ...(isRecord(body) && isRecord(body.input)
                  ? { input: body.input }
                  : {}),
              },
              userId,
            );
            set.status = 202;
            return { execution };
          },
        );
      },
    )

    .get(
      "/agents/:id/workflows/:workflowId/executions",
      async ({ params, query, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;

        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) => {
            await requireWorkflowOwnership(service, userId, params.workflowId);
            const response = await service.listExecutions(
              {
                workflowId: params.workflowId,
                limit: boundedLimit(query.limit, 10),
              },
              userId,
            );
            return { executions: response.data };
          },
        );
      },
    )

    .get(
      "/agents/:id/workflows/:workflowId/evaluation-samples",
      async ({ params, query, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;

        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) => {
            await requireWorkflowOwnership(service, userId, params.workflowId);
            return service.getWorkflowEvaluationSuite(
              params.workflowId,
              boundedLimit(query.limit, 10),
              userId,
            );
          },
        );
      },
    )

    .get(
      "/agents/:id/workflows/executions/:executionId",
      async ({ params, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;

        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) => ({
            execution: await getOwnedExecution(
              service,
              userId,
              params.executionId,
            ),
          }),
        );
      },
    )

    .post(
      "/agents/:id/workflows/executions/:executionId/cancel",
      async ({ params, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;
        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) => {
            await getOwnedExecution(service, userId, params.executionId);
            return {
              execution: await service.cancelExecution(
                params.executionId,
                userId,
              ),
            };
          },
        );
      },
    )

    .post(
      "/agents/:id/workflows/executions/:executionId/approvals/:nodeId/:iteration",
      async ({ params, body, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;
        if (
          !isRecord(body) ||
          (body.approved !== true && body.approved !== false)
        ) {
          set.status = 400;
          return { success: false, error: "approved must be a boolean" };
        }
        const approved = body.approved;
        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) => {
            await getOwnedExecution(service, userId, params.executionId);
            return {
              execution: await service.decideApproval(
                params.executionId,
                params.nodeId,
                Number(params.iteration),
                approved,
                {
                  decidedBy: userId,
                  ...(typeof body.note === "string" ? { note: body.note } : {}),
                  ...(body.decision !== undefined
                    ? { decision: body.decision }
                    : {}),
                },
              ),
            };
          },
        );
      },
    )

    .post(
      "/agents/:id/workflows/executions/:executionId/signals/:signal",
      async ({ params, body, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;
        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) => {
            await getOwnedExecution(service, userId, params.executionId);
            return {
              execution: await service.signalExecution(
                params.executionId,
                params.signal,
                isRecord(body) ? body.payload : undefined,
                userId,
              ),
            };
          },
        );
      },
    )

    .get(
      "/agents/:id/workflows/:workflowId/revisions",
      async ({ params, query, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;

        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) => {
            const workflow = await getOwnedWorkflow(
              service,
              userId,
              params.workflowId,
            );
            if (!isRecord(workflow) || typeof workflow.versionId !== "string") {
              throw workflowRouteError(
                500,
                "workflow_revision_state_invalid",
                "Workflow is missing its current revision",
              );
            }
            const revisions = await service.getWorkflowRevisions(
              params.workflowId,
              boundedLimit(query.limit, 20),
              userId,
            );
            return {
              currentVersionId: workflow.versionId,
              revisions,
            };
          },
        );
      },
    )

    .post(
      "/agents/:id/workflows/:workflowId/revisions/:versionId/restore",
      async ({ params, headers, set }) => {
        const headerMap = headers as HeaderMap;
        const denial = requireInternalAuth(headerMap, set, sharedSecret);
        if (denial) return denial;
        const userId = requireWorkflowPrincipal(headerMap, set);
        if (typeof userId !== "string") return userId;

        return await withWorkflowService(
          manager,
          params.id,
          set,
          async (service) => {
            await requireWorkflowOwnership(service, userId, params.workflowId);
            try {
              return await service.restoreWorkflowRevision(
                params.workflowId,
                params.versionId,
                userId,
              );
            } catch (error) {
              // error-policy:J2 preserve a known upstream 404 while adding the
              // route-specific revision classification.
              if (errorStatusCode(error) === 404) {
                throw workflowRouteError(
                  404,
                  "workflow_revision_not_found",
                  "Workflow revision not found",
                  error,
                );
              }
              throw error;
            }
          },
        );
      },
    )

    .post("/drain", async ({ headers, set }) => {
      const denial = requireInternalAuth(
        headers as HeaderMap,
        set,
        sharedSecret,
      );
      if (denial) {
        return denial;
      }
      await manager.drain();
      await manager.cleanupRedis();
      return { drained: true };
    });
}
