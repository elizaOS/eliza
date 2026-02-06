/**
 * A2A (Agent-to-Agent) JSON-RPC Endpoint
 *
 * Implements the A2A protocol specification v0.3.0
 * @see https://google.github.io/a2a-spec/
 *
 * Standard Methods:
 * - message/send: Send a message to create/continue a task
 * - tasks/get: Get task status and history
 * - tasks/cancel: Cancel a running task
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod3";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { checkRateLimitRedis } from "@/lib/middleware/rate-limit-redis";
import { logger } from "@/lib/utils/logger";
import {
  type A2AContext,
  type MessageSendParams,
  type TaskGetParams,
  type TaskCancelParams,
  A2AErrorCodes,
  jsonRpcSuccess,
  jsonRpcError,
  handleMessageSend,
  handleTasksGet,
  handleTasksCancel,
  AVAILABLE_SKILLS,
} from "@/lib/api/a2a";

export const maxDuration = 60;

// JSON-RPC response helpers
function a2aError(
  code: number,
  message: string,
  id: string | number | null,
  status = 400,
): NextResponse {
  return NextResponse.json(jsonRpcError(code, message, id), { status });
}

function a2aSuccess<T>(result: T, id: string | number | null): NextResponse {
  return NextResponse.json(jsonRpcSuccess(result, id));
}

// Method registry
type MethodHandler = (
  params: Record<string, unknown>,
  ctx: A2AContext,
) => Promise<unknown>;

const METHODS: Record<string, { handler: MethodHandler; description: string }> =
  {
    "message/send": {
      handler: (params, ctx) =>
        handleMessageSend(params as unknown as MessageSendParams, ctx),
      description: "Send a message to create/continue a task (A2A standard)",
    },
    "tasks/get": {
      handler: (params, ctx) =>
        handleTasksGet(params as unknown as TaskGetParams, ctx),
      description: "Get task status and history (A2A standard)",
    },
    "tasks/cancel": {
      handler: (params, ctx) =>
        handleTasksCancel(params as unknown as TaskCancelParams, ctx),
      description: "Cancel a running task (A2A standard)",
    },
  };

// Request schema
const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
  id: z.union([z.string(), z.number(), z.null()]),
});

// POST Handler
export async function POST(request: NextRequest) {
  // Parse JSON
  let body: unknown;
  const bodyText = await request.text();
  try {
    body = JSON.parse(bodyText);
  } catch {
    return a2aError(
      A2AErrorCodes.PARSE_ERROR,
      "Parse error: Invalid JSON",
      null,
    );
  }

  const parsed = JsonRpcRequestSchema.safeParse(body);
  if (!parsed.success) {
    return a2aError(
      A2AErrorCodes.INVALID_REQUEST,
      "Invalid Request: Does not conform to JSON-RPC 2.0",
      null,
    );
  }

  const { method, params, id } = parsed.data;

  // Auth
  let authResult: Awaited<ReturnType<typeof requireAuthOrApiKeyWithOrg>>;
  try {
    authResult = await requireAuthOrApiKeyWithOrg(request);
  } catch (e) {
    return a2aError(
      A2AErrorCodes.AUTHENTICATION_REQUIRED,
      e instanceof Error ? e.message : "Auth failed",
      id,
      401,
    );
  }

  // Rate limit
  const rateLimitResult = await checkRateLimitRedis(
    `a2a:${authResult.user.organization_id}`,
    60000,
    100,
  );
  if (!rateLimitResult.allowed) {
    return a2aError(A2AErrorCodes.RATE_LIMITED, "Rate limited", id, 429);
  }

  // Find handler
  const methodDef = METHODS[method];
  if (!methodDef) {
    return a2aError(
      A2AErrorCodes.METHOD_NOT_FOUND,
      `Method not found: ${method}`,
      id,
      404,
    );
  }

  // Execute
  logger.info(`[A2A] ${method}`, {
    org: authResult.user.organization_id,
    user: authResult.user.id,
  });

  const ctx: A2AContext = {
    user: authResult.user,
    apiKeyId: authResult.apiKey?.id || null,
    agentIdentifier: `org:${authResult.user.organization_id}`,
  };

  try {
    const result = await methodDef.handler(params || {}, ctx);
    return a2aSuccess(result, id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Internal error";

    // Determine error code
    let code: number = A2AErrorCodes.INTERNAL_ERROR;
    let status = 500;

    if (msg.includes("Insufficient")) {
      code = A2AErrorCodes.INSUFFICIENT_CREDITS;
      status = 402;
    } else if (msg.includes("not found")) {
      code = A2AErrorCodes.TASK_NOT_FOUND;
      status = 404;
    } else if (msg.includes("suspended") || msg.includes("banned")) {
      code = A2AErrorCodes.AGENT_BANNED;
      status = 403;
    }

    return a2aError(code, msg, id, status);
  }
}

// GET Handler - Service Discovery
export async function GET() {
  return NextResponse.json({
    name: "Eliza Cloud A2A",
    version: "1.0.0",
    protocolVersion: "0.3.0",
    protocol: "JSON-RPC 2.0",
    documentation: "https://google.github.io/a2a-spec/",
    agentCard: "/.well-known/agent-card.json",
    methods: Object.entries(METHODS).map(([name, def]) => ({
      name,
      description: def.description,
      isStandard: true,
    })),
    skills: AVAILABLE_SKILLS,
  });
}

// OPTIONS Handler - CORS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-API-Key, X-App-Id, X-PAYMENT, X-Agent-Token-Id, X-Agent-Chain-Id",
    },
  });
}
