/**
 * A2A Protocol Endpoint
 *
 * Implements the standard A2A protocol using @a2a-js/sdk.
 * Handles Agent-to-Agent JSON-RPC 2.0 requests over HTTP.
 *
 * @openapi
 * /api/a2a:
 *   post:
 *     tags:
 *       - A2A Protocol
 *     summary: A2A JSON-RPC endpoint
 *     description: Handles all Agent-to-Agent JSON-RPC 2.0 requests over HTTP for autonomous agent communication.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - jsonrpc
 *               - method
 *             properties:
 *               jsonrpc:
 *                 type: string
 *                 enum: ["2.0"]
 *               method:
 *                 type: string
 *                 description: A2A method name (e.g., message/send, tasks/get)
 *               params:
 *                 type: object
 *               id:
 *                 type: string
 *     responses:
 *       200:
 *         description: JSON-RPC response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jsonrpc:
 *                   type: string
 *                 result:
 *                   type: object
 *                 error:
 *                   type: object
 *                 id:
 *                   type: string
 *   get:
 *     tags:
 *       - A2A Protocol
 *     summary: A2A service info
 *     description: Returns A2A protocol service information and agent card endpoint.
 *     responses:
 *       200:
 *         description: Service info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 service:
 *                   type: string
 *                 version:
 *                   type: string
 *                 status:
 *                   type: string
 *                 endpoint:
 *                   type: string
 *                 agentCard:
 *                   type: string
 */

import {
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  JsonRpcTransportHandler,
} from "@a2a-js/sdk/server";
import {
  FeedAgentExecutor,
  feedAgentCard,
  PersistentTaskStore,
} from "@feed/a2a";
import { withErrorHandling } from "@feed/api";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { checkApiKey } from "@/lib/api/check-api-key";

// Initialize A2A protocol components with Redis-backed persistence
const taskStore = new PersistentTaskStore();
const executor = new FeedAgentExecutor();
const eventBusManager = new DefaultExecutionEventBusManager();
const requestHandler = new DefaultRequestHandler(
  feedAgentCard,
  taskStore,
  executor,
  eventBusManager,
);
const jsonRpcHandler = new JsonRpcTransportHandler(requestHandler);

export const dynamic = "force-dynamic";

/**
 * POST /api/a2a
 *
 * Handles JSON-RPC 2.0 A2A protocol requests. Processes agent-to-agent communication
 * tasks including message sending, task execution, and agent discovery.
 *
 * Supports authentication via:
 * - Server API key (FEED_A2A_API_KEY)
 * - Per-user API keys (from userApiKeys table)
 *
 * @param request - Next.js request containing JSON-RPC 2.0 A2A protocol message
 * @returns JSON-RPC 2.0 response with result or error
 * @throws {401} Invalid or missing API key
 */
export const POST = withErrorHandling(async function POST(
  request: NextRequest,
) {
  const { error, authResult } = await checkApiKey(request);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: Invalid JSON" },
        id: null,
      },
      { status: 400 },
    );
  }

  logger.info("Official A2A request", {
    method: body.method,
    taskId: body.params?.message?.taskId,
    authMethod: authResult?.authMethod,
    userId: authResult?.userId,
  });

  // SECURITY: User-scoped execution for user API keys
  // When authenticated via per-user API key, enforce that the ACTOR identity
  // (contextId) is the authenticated user. This prevents impersonation attacks.
  //
  // NOTE: We do NOT enforce params.userId because many operations use it as
  // the TARGET (e.g., blockUser targets params.userId, actor is contextId).
  // The executor uses contextId as the actor for all write operations.
  if (authResult?.authMethod === "user-key") {
    const authenticatedUserId = authResult.userId;

    // Validate userId is present and non-empty
    if (!authenticatedUserId || typeof authenticatedUserId !== "string") {
      logger.error("User API key authenticated but userId is missing", {
        authMethod: authResult.authMethod,
        hasUserId: !!authenticatedUserId,
      });
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Authentication error: Invalid user identity",
          },
          id: body.id ?? null,
        },
        { status: 401 },
      );
    }

    // Type guard: ensure params is a plain object
    const isPlainObject = (val: unknown): val is Record<string, unknown> =>
      typeof val === "object" && val !== null && !Array.isArray(val);

    // Ensure params exists and is a plain object
    if (!isPlainObject(body.params)) {
      body.params = {};
    }

    // Validate and override contextId in message params
    if (isPlainObject(body.params.message)) {
      if (
        body.params.message.contextId &&
        body.params.message.contextId !== authenticatedUserId
      ) {
        logger.warn("Overriding mismatched message contextId", {
          providedContextId: body.params.message.contextId,
          authenticatedUserId,
        });
      }
      body.params.message.contextId = authenticatedUserId;
    }

    // Validate and override contextId at params level (for tasks/get and other methods)
    if (
      body.params.contextId &&
      body.params.contextId !== authenticatedUserId
    ) {
      logger.warn("Overriding mismatched params contextId", {
        providedContextId: body.params.contextId,
        authenticatedUserId,
      });
    }
    body.params.contextId = authenticatedUserId;
  }

  // SECURITY: Server API key and localhost bypass
  // These auth methods allow arbitrary contextId, which enables acting as any user.
  // This is intentional for admin/internal operations but should be monitored.
  if (
    authResult?.authMethod === "server-key" ||
    authResult?.authMethod === "localhost"
  ) {
    const providedContextId =
      body.params?.message?.contextId ?? body.params?.contextId;
    if (providedContextId !== undefined && providedContextId !== null) {
      // Log server-key operations with user context for audit trail
      logger.info("Server/localhost A2A operation with user context", {
        authMethod: authResult.authMethod,
        contextId: providedContextId,
        method: body.method,
        operation: body.params?.message?.parts?.[0]?.data?.operation,
      });
    }
  }

  // Delegate all A2A methods to the SDK's JSON-RPC transport handler
  // This includes message/send, message/stream, tasks/get, tasks/list, etc.
  // The SDK handles task persistence, streaming, and event bus management internally
  const response = await jsonRpcHandler.handle(body);

  return NextResponse.json(response, {
    headers: {
      "Content-Type": "application/json",
    },
  });
});

/**
 * GET /api/a2a
 *
 * Returns the Feed agent card (capabilities, endpoints, metadata) for A2A protocol discovery.
 * Provides agent information for external agents to discover and interact with this agent.
 *
 * Supports authentication via:
 * - Server API key (FEED_A2A_API_KEY)
 * - Per-user API keys (from userApiKeys table)
 *
 * @param request - Next.js request (API key required in X-Feed-Api-Key header)
 * @returns Agent card JSON with capabilities and metadata
 * @throws {401} Invalid or missing API key
 */
export const GET = withErrorHandling(async function GET(request: NextRequest) {
  const { error } = await checkApiKey(request);
  if (error) return error;

  return NextResponse.json(feedAgentCard, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
});
