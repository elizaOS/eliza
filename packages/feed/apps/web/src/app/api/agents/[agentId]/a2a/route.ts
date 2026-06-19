/**
 * Per-Agent A2A Server Endpoint
 *
 * @route POST /api/agents/[agentId]/a2a - A2A message handler
 * @route GET /api/agents/[agentId]/a2a - A2A capabilities
 * @access Public (with agent authentication)
 *
 * @description
 * A2A server endpoint for individual agents. When an agent has A2A enabled,
 * this endpoint allows other agents to communicate with it directly via the
 * A2A protocol. This enables agent-to-agent communication outside of the
 * ordinary gameplay. Uses MessageRouter scoped to the specific agent.
 *
 * @openapi
 * /api/agents/{agentId}/a2a:
 *   post:
 *     tags:
 *       - Agents
 *     summary: Handle A2A message
 *     description: Processes A2A protocol message for agent (agent authentication required)
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Agent user ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Message processed successfully
 *       400:
 *         description: Invalid A2A message
 *       404:
 *         description: Agent not found or A2A not enabled
 *   get:
 *     tags:
 *       - Agents
 *     summary: Get A2A capabilities
 *     description: Returns A2A capabilities for agent
 *     parameters:
 *       - in: path
 *         name: agentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Agent user ID
 *     responses:
 *       200:
 *         description: Capabilities retrieved successfully
 *       404:
 *         description: Agent not found or A2A not enabled
 *
 * @example
 * ```typescript
 * // Send A2A message
 * await fetch(`/api/agents/${agentId}/a2a`, {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${agentToken}` },
 *   body: JSON.stringify({ message: 'A2A message' })
 * });
 * ```
 */

import type { Task } from "@a2a-js/sdk";
import type { DefaultRequestHandler as DefaultRequestHandlerType } from "@a2a-js/sdk/server";
import {
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  JsonRpcTransportHandler,
} from "@a2a-js/sdk/server";
import {
  ErrorCode,
  FeedAgentExecutor,
  generateAgentCardSync,
  type JsonRpcRequest,
  type ListTasksParams,
  PersistentTaskStore,
  RateLimiter,
} from "@feed/a2a";
import { getAgentConfig } from "@feed/agents";
import { withErrorHandling } from "@feed/api";
import { db, eq, users } from "@feed/db";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Type assertions are used instead of type guards due to intersection type issues

export const dynamic = "force-dynamic";

// Per-agent handlers (cached per agent)
const agentRateLimiters = new Map<string, RateLimiter>();
const agentRequestHandlers = new Map<string, DefaultRequestHandlerType>();
const agentJsonRpcHandlers = new Map<string, JsonRpcTransportHandler>();

function getAgentRateLimiter(agentId: string): RateLimiter {
  if (!agentRateLimiters.has(agentId)) {
    agentRateLimiters.set(agentId, new RateLimiter(100));
  }
  return agentRateLimiters.get(agentId)!;
}

/**
 * Helper to extract and validate taskId from request body params.
 * Handles both 'id' and 'taskId' parameter names.
 *
 * @returns Object with taskId, or errorResponse if validation fails
 */
function getTaskIdFromParams(
  body: JsonRpcRequest,
):
  | { taskId: string; errorResponse?: never }
  | { errorResponse: NextResponse; taskId?: never } {
  const params = body.params as { id?: string; taskId?: string } | undefined;
  const taskId = params?.id || params?.taskId;

  if (!taskId) {
    return {
      errorResponse: NextResponse.json(
        {
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: {
            code: -32602,
            message: "Invalid params: taskId or id is required",
          },
        },
        { status: 400 },
      ),
    };
  }

  return { taskId };
}

/**
 * Helper to extract taskId and taskStore from request body and agent handler.
 * Consolidates duplicated code across tasks/get, tasks/cancel, and tasks/resubscribe.
 *
 * @returns Object with taskStore and taskId, or errorResponse if validation fails
 */
async function getTaskStoreAndTaskId(
  body: JsonRpcRequest,
  agentId: string,
): Promise<
  | { taskStore: PersistentTaskStore; taskId: string; errorResponse?: never }
  | { errorResponse: NextResponse; taskStore?: never; taskId?: never }
> {
  const taskIdResult = getTaskIdFromParams(body);
  if (taskIdResult.errorResponse) {
    return { errorResponse: taskIdResult.errorResponse };
  }

  const jsonRpcHandler = await getAgentJsonRpcHandler(agentId);
  const handlerWithRequestHandler = jsonRpcHandler as unknown as {
    requestHandler: {
      taskStore: PersistentTaskStore;
    };
  };
  const taskStore = handlerWithRequestHandler.requestHandler.taskStore;

  return { taskStore, taskId: taskIdResult.taskId };
}

async function getAgentJsonRpcHandler(
  agentId: string,
): Promise<JsonRpcTransportHandler> {
  if (!agentJsonRpcHandlers.has(agentId)) {
    if (!agentRequestHandlers.has(agentId)) {
      // Use PersistentTaskStore for Redis-backed persistence across instances
      const taskStore = new PersistentTaskStore();
      // Create executor scoped to this agent
      const executor = new FeedAgentExecutor();
      const eventBusManager = new DefaultExecutionEventBusManager();

      // Get agent data for card generation
      const [agentUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, agentId))
        .limit(1);
      const agentConfig = await getAgentConfig(agentId);

      if (!agentUser) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const agentCardData = {
        id: agentUser.id,
        displayName: agentUser.displayName,
        bio: agentUser.bio,
        profileImageUrl: agentUser.profileImageUrl,
        systemPrompt: agentConfig?.systemPrompt ?? null,
        personality: agentConfig?.personality ?? null,
        tradingStrategy: agentConfig?.tradingStrategy ?? null,
      };

      const requestHandler = new DefaultRequestHandler(
        generateAgentCardSync(agentCardData),
        taskStore,
        executor,
        eventBusManager,
      );
      agentRequestHandlers.set(agentId, requestHandler);
    }
    const requestHandler = agentRequestHandlers.get(agentId)!;
    agentJsonRpcHandlers.set(
      agentId,
      new JsonRpcTransportHandler(requestHandler),
    );
  }
  return agentJsonRpcHandlers.get(agentId)!;
}

export const POST = withErrorHandling(async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;

  // Verify agent exists and has A2A enabled
  const [agent] = await db
    .select()
    .from(users)
    .where(eq(users.id, agentId))
    .limit(1);
  const agentConfig = await getAgentConfig(agentId);

  if (!agent?.isAgent) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: ErrorCode.AGENT_NOT_FOUND,
          message: "Agent not found",
        },
      },
      { status: 404 },
    );
  }

  if (!agentConfig?.a2aEnabled) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: ErrorCode.INVALID_REQUEST,
          message: "A2A is not enabled for this agent",
        },
      },
      { status: 403 },
    );
  }

  const body = (await req.json()) as JsonRpcRequest;

  const requestingAgentId =
    req.headers.get("x-agent-id") ||
    req.headers.get("x-agent-address") ||
    "anonymous";

  // Check rate limit
  const limiter = getAgentRateLimiter(agentId);
  const allowed = limiter.checkLimit(requestingAgentId);

  if (!allowed) {
    const remainingTokens = limiter.getTokens(requestingAgentId);
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: {
          code: ErrorCode.RATE_LIMIT_EXCEEDED,
          message: "Rate limit exceeded",
          data: {
            limit: 100,
            remaining: remainingTokens,
            resetAt: Date.now() + 60000,
          },
        },
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": "100",
          "X-RateLimit-Remaining": remainingTokens.toString(),
          "X-RateLimit-Reset": (Date.now() + 60000).toString(),
        },
      },
    );
  }

  logger.info("Per-agent A2A Request received", {
    agentId,
    requestingAgentId,
    method: body.method,
    id: body.id,
  });

  // Handle official A2A methods
  const officialMethods = [
    "message/send",
    "message/stream",
    "tasks/get",
    "tasks/cancel",
    "tasks/list",
    "tasks/pushNotificationConfig/set",
    "tasks/pushNotificationConfig/get",
    "tasks/pushNotificationConfig/list",
    "tasks/pushNotificationConfig/delete",
    "tasks/resubscribe",
    "agent/getAuthenticatedExtendedCard",
  ];

  if (officialMethods.includes(body.method)) {
    // Handle tasks/list manually
    if (body.method === "tasks/list") {
      const jsonRpcHandler = await getAgentJsonRpcHandler(agentId);

      // Use type assertions to access internal SDK structure
      // These properties exist at runtime but aren't in the public types
      const handlerWithRequestHandler = jsonRpcHandler as unknown as {
        requestHandler: {
          taskStore: PersistentTaskStore;
        };
      };
      const taskStore = handlerWithRequestHandler.requestHandler.taskStore;

      const params = (body.params || {}) as {
        contextId?: string;
        status?: string;
        pageSize?: number;
        pageToken?: string;
        historyLength?: number;
        includeArtifacts?: boolean;
        lastUpdatedAfter?: number;
      };

      if (
        params.pageSize !== undefined &&
        (params.pageSize < 1 || params.pageSize > 100)
      ) {
        return NextResponse.json(
          {
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: {
              code: -32602,
              message: "Invalid params: pageSize must be between 1 and 100",
              data: { pageSize: params.pageSize },
            },
          },
          { status: 400 },
        );
      }

      if (params.historyLength !== undefined && params.historyLength < 0) {
        return NextResponse.json(
          {
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: {
              code: -32602,
              message: "Invalid params: historyLength must be non-negative",
              data: { historyLength: params.historyLength },
            },
          },
          { status: 400 },
        );
      }

      const listParams: ListTasksParams = {
        contextId: params.contextId,
        status:
          params.status === "pending"
            ? "submitted"
            : params.status === "running"
              ? "working"
              : params.status === "cancelled"
                ? "canceled"
                : (params.status as
                    | "submitted"
                    | "working"
                    | "completed"
                    | "failed"
                    | "canceled"
                    | undefined),
        pageSize: params.pageSize || 20,
        pageToken: params.pageToken,
        historyLength: params.historyLength,
        includeArtifacts: params.includeArtifacts || false,
        lastUpdatedAfter: params.lastUpdatedAfter,
      };

      const tasks = await taskStore.list(listParams);

      return NextResponse.json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          tasks: tasks.tasks,
          nextPageToken: tasks.nextPageToken,
        },
      });
    }

    // Handle tasks/get manually - SDK expects params.id but clients may send params.taskId
    if (body.method === "tasks/get") {
      const result = await getTaskStoreAndTaskId(body, agentId);
      if (result.errorResponse) return result.errorResponse;

      const { taskStore, taskId } = result;
      const task = await taskStore.load(taskId);

      if (!task) {
        return NextResponse.json(
          {
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: {
              code: -32001,
              message: `Task not found: ${taskId}`,
            },
          },
          { status: 404 },
        );
      }

      return NextResponse.json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: { task },
      });
    }

    // Handle tasks/cancel manually - SDK expects params.id but clients may send params.taskId
    if (body.method === "tasks/cancel") {
      const result = await getTaskStoreAndTaskId(body, agentId);
      if (result.errorResponse) return result.errorResponse;

      const { taskStore, taskId } = result;

      // Use atomic updateStatus to avoid load-modify-save race conditions
      const canceledTask = await taskStore.updateStatus(taskId, {
        state: "canceled",
        timestamp: new Date().toISOString(),
      });

      if (!canceledTask) {
        return NextResponse.json(
          {
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: {
              code: -32001,
              message: `Task not found: ${taskId}`,
            },
          },
          { status: 404 },
        );
      }

      return NextResponse.json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: { task: canceledTask },
      });
    }

    // Handle tasks/resubscribe with SSE response using SDK's resubscribe method
    if (body.method === "tasks/resubscribe") {
      const taskIdResult = getTaskIdFromParams(body);
      if (taskIdResult.errorResponse) {
        return taskIdResult.errorResponse;
      }
      const taskId = taskIdResult.taskId;

      // Get the request handler to access resubscribe method
      await getAgentJsonRpcHandler(agentId); // Ensures handler is initialized
      const requestHandler = agentRequestHandlers.get(agentId);

      if (!requestHandler) {
        return NextResponse.json(
          {
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: {
              code: -32001,
              message: "Request handler not available",
            },
          },
          { status: 500 },
        );
      }

      // Use SDK's resubscribe which returns AsyncGenerator<Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent>
      const encoder = new TextEncoder();
      const eventGenerator = requestHandler.resubscribe({ id: taskId });

      const stream = new ReadableStream({
        async start(controller) {
          // Wire abort signal to cancel the stream when client disconnects
          const abortHandler = () => {
            // Terminate the async generator first
            eventGenerator.return(undefined).catch(() => {
              // Ignore errors from terminating generator
            });
            try {
              controller.close();
            } catch {
              // Controller may already be closed
            }
          };
          req.signal.addEventListener("abort", abortHandler);

          try {
            for await (const event of eventGenerator) {
              // Check if request was aborted
              if (req.signal.aborted) break;

              // Determine event type based on 'kind' property from SDK types
              if ("kind" in event) {
                if (event.kind === "status-update") {
                  controller.enqueue(
                    encoder.encode(
                      `event: task-status\ndata: ${JSON.stringify({
                        taskId: event.taskId,
                        contextId: event.contextId,
                        status: event.status,
                        final: event.final,
                      })}\n\n`,
                    ),
                  );
                } else if (event.kind === "artifact-update") {
                  controller.enqueue(
                    encoder.encode(
                      `event: task-artifact\ndata: ${JSON.stringify({
                        taskId: event.taskId,
                        artifact: event.artifact,
                      })}\n\n`,
                    ),
                  );
                }
              } else {
                // It's a Task object - send as initial state
                const taskEvent = event as Task;
                controller.enqueue(
                  encoder.encode(
                    `event: task-status\ndata: ${JSON.stringify({
                      taskId: taskEvent.id,
                      contextId: taskEvent.contextId,
                      status: taskEvent.status,
                    })}\n\n`,
                  ),
                );
              }
            }
          } catch (error) {
            logger.error(
              "Error in resubscribe stream",
              { error: String(error), taskId },
              "A2A",
            );
          } finally {
            req.signal.removeEventListener("abort", abortHandler);
            try {
              controller.close();
            } catch {
              // Controller may already be closed
            }
          }
        },
        async cancel(reason) {
          // Cleanup: terminate the async generator when stream is cancelled
          try {
            await eventGenerator.return(reason);
          } catch (error) {
            logger.debug(
              "Error terminating event generator",
              { error: String(error), taskId },
              "A2A",
            );
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // Handle other official methods via SDK handler
    const jsonRpcHandler = await getAgentJsonRpcHandler(agentId);
    const response = await jsonRpcHandler.handle(body);

    return NextResponse.json(response, {
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": "100",
        "X-RateLimit-Remaining": limiter
          .getTokens(requestingAgentId)
          .toString(),
      },
    });
  }

  // All methods should be handled above via official A2A protocol
  // If we reach here, it's an unsupported method
  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id: body.id ?? null,
      error: {
        code: ErrorCode.METHOD_NOT_FOUND,
        message: `Method ${body.method} not supported. Use official A2A methods: message/send, tasks/get, tasks/list`,
      },
    },
    { status: 404 },
  );
});

export const GET = withErrorHandling(async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await params;

  // Verify agent exists and has A2A enabled
  const [agent] = await db
    .select()
    .from(users)
    .where(eq(users.id, agentId))
    .limit(1);
  const config = await getAgentConfig(agentId);

  if (!agent?.isAgent) {
    return NextResponse.json(
      {
        error: "Agent not found",
      },
      { status: 404 },
    );
  }

  if (!config?.a2aEnabled) {
    return NextResponse.json(
      {
        error: "A2A is not enabled for this agent",
      },
      { status: 403 },
    );
  }

  const agentCard = generateAgentCardSync({
    id: agent.id,
    displayName: agent.displayName,
    bio: agent.bio,
    profileImageUrl: agent.profileImageUrl,
    systemPrompt: config?.systemPrompt ?? null,
    personality: config?.personality ?? null,
    tradingStrategy: config?.tradingStrategy ?? null,
  });

  return NextResponse.json(
    {
      service: "A2A Server",
      status: "active",
      endpoint: `/api/agents/${agentId}/a2a`,
      agentCard,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
});
