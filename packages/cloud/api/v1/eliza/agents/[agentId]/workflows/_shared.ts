/**
 * Authenticates Cloud workflow requests, verifies agent ownership, and proxies
 * them to the assigned agent server. When no compatible runtime is assigned,
 * callers receive a typed dedicated-upgrade or retryable-unavailable response.
 */

import {
  ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT,
  ACTIVATION_ROUTING_UPSTASH_READ_ONLY_SCRIPT,
  type ActivationRoutingSnapshotKeys,
  type AgentServerRoutingReader,
  resolveAgentServerRouting,
} from "@elizaos/cloud-services-common";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { buildRedisClient, evalRedisReadOnly } from "@/lib/cache/redis-factory";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppContext } from "@/types/cloud-worker-env";

const WORKFLOW_CORS_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const WORKFLOW_PROXY_DEFAULT_TIMEOUT_MS = 120_000;
const WORKFLOW_PROXY_GENERATION_TIMEOUT_MS = 5 * 60_000;
const WORKFLOW_PROXY_RUN_TIMEOUT_MS = 10 * 60_000;
const DEDICATED_LAZY_INACTIVE_STATUSES = new Set([
  "stopped",
  "sleeping",
  "disconnected",
]);
const ROUTING_VALUE_SNAPSHOT_SENTINEL = "agent-server-routing-value:v1";
const ROUTING_VALUE_MISSING_SENTINEL = "agent-server-routing-missing:v1";
const ROUTING_VALUE_PREFIX = "agent-server-routing:v1:";
const ROUTING_VALUE_READ_SCRIPT_BODY = `if #KEYS ~= 1 or #ARGV ~= 0 then
  return redis.error_reply("agent-server routing read requires exactly 1 key and 0 args")
end

local value = redis.call("GET", KEYS[1])
if value == false then
  return {"${ROUTING_VALUE_SNAPSHOT_SENTINEL}", "${ROUTING_VALUE_MISSING_SENTINEL}"}
end
return {"${ROUTING_VALUE_SNAPSHOT_SENTINEL}", "${ROUTING_VALUE_PREFIX}" .. value}
`;
const ROUTING_VALUE_REDIS_EVAL_RO_SCRIPT = ROUTING_VALUE_READ_SCRIPT_BODY;
const ROUTING_VALUE_UPSTASH_READ_ONLY_SCRIPT = `#!lua flags=no-writes,allow-key-locking\n${ROUTING_VALUE_READ_SCRIPT_BODY}`;

type WorkflowAgentExecutionTier =
  | "shared"
  | "dedicated-lazy"
  | "dedicated-always"
  | "custom";

export function workflowRuntimeUnavailableResponse(
  agentId: string,
  executionTier: WorkflowAgentExecutionTier,
): Response {
  if (executionTier === "shared") {
    return Response.json(
      {
        success: false,
        code: "workflow_requires_dedicated",
        error:
          "Workflows require a dedicated agent runtime. Upgrade this agent before managing workflows.",
        capability: "workflows",
        currentExecutionTier: executionTier,
        requiredExecutionTier: "dedicated-always",
        upgradeRequired: true,
        upgrade: {
          automatic: false,
          method: "POST",
          endpoint: `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/upgrade-tier`,
        },
      },
      { status: 409 },
    );
  }

  return Response.json(
    {
      success: false,
      code: "workflow_runtime_unavailable",
      error: "The agent workflow runtime is temporarily unavailable.",
      capability: "workflows",
      currentExecutionTier: executionTier,
      upgradeRequired: false,
      retryable: true,
    },
    { status: 503 },
  );
}

function envString(c: AppContext | undefined, key: string): string | null {
  const value = c?.env?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decodeRoutingValueSnapshot(evaluated: unknown): string | null {
  if (
    !Array.isArray(evaluated) ||
    evaluated.length !== 2 ||
    evaluated[0] !== ROUTING_VALUE_SNAPSHOT_SENTINEL
  ) {
    throw new TypeError("Invalid agent-server routing value snapshot");
  }

  const encoded = evaluated[1];
  if (encoded === ROUTING_VALUE_MISSING_SENTINEL) return null;
  if (
    typeof encoded !== "string" ||
    !encoded.startsWith(ROUTING_VALUE_PREFIX)
  ) {
    throw new TypeError("Invalid agent-server routing value envelope");
  }
  return encoded.slice(ROUTING_VALUE_PREFIX.length);
}

function createWorkflowRoutingReader(c: AppContext): AgentServerRoutingReader {
  let redis: ReturnType<typeof buildRedisClient> | undefined;
  const requireRedis = (): NonNullable<ReturnType<typeof buildRedisClient>> => {
    if (redis === undefined) redis = buildRedisClient(c.env);
    if (!redis) throw new Error("Redis is not configured");
    return redis;
  };

  return {
    readActivationRoutingSnapshot(
      keys: ActivationRoutingSnapshotKeys,
    ): Promise<unknown> {
      return evalRedisReadOnly(
        requireRedis(),
        {
          directRedis: ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT,
          upstashRedis: ACTIVATION_ROUTING_UPSTASH_READ_ONLY_SCRIPT,
        },
        [...keys],
        [],
      );
    },
    async readAgentServerRoutingValue(key: string): Promise<string | null> {
      const evaluated = await evalRedisReadOnly(
        requireRedis(),
        {
          directRedis: ROUTING_VALUE_REDIS_EVAL_RO_SCRIPT,
          upstashRedis: ROUTING_VALUE_UPSTASH_READ_ONLY_SCRIPT,
        },
        [key],
        [],
      );
      return decodeRoutingValueSnapshot(evaluated);
    },
  };
}

function buildTargetUrl(
  serverUrl: string,
  requestUrl: string,
  agentId: string,
  suffix: string,
): URL {
  const request = new URL(requestUrl);
  const target = new URL(serverUrl);
  const normalizedSuffix = suffix ? `/${suffix.replace(/^\/+/, "")}` : "";
  target.pathname = `/agents/${encodeURIComponent(agentId)}/workflows${normalizedSuffix}`;
  target.search = request.search;
  return target;
}

/** Keeps long generation/run calls alive while bounding ordinary proxy work. */
export function workflowProxyTimeoutMs(method: string, suffix: string): number {
  if (method.toUpperCase() !== "POST") {
    return WORKFLOW_PROXY_DEFAULT_TIMEOUT_MS;
  }
  const normalizedSuffix = suffix.replace(/^\/+|\/+$/g, "");
  if (/(?:^|\/)run$/.test(normalizedSuffix)) {
    return WORKFLOW_PROXY_RUN_TIMEOUT_MS;
  }
  if (
    normalizedSuffix === "generate" ||
    normalizedSuffix === "resolve-clarification"
  ) {
    return WORKFLOW_PROXY_GENERATION_TIMEOUT_MS;
  }
  return WORKFLOW_PROXY_DEFAULT_TIMEOUT_MS;
}

async function wakeDedicatedLazyRuntime(params: {
  ctx: AppContext;
  agentId: string;
  user: { id: string; organization_id: string };
}): Promise<Response> {
  const creditCheck = await checkAgentCreditGate(params.user.organization_id);
  if (!creditCheck.allowed) {
    return Response.json(
      insufficientCredits402(
        creditCheck,
        "[workflow-proxy] Wake blocked: insufficient credits",
        {
          agentId: params.agentId,
          orgId: params.user.organization_id,
        },
      ),
      { status: 402 },
    );
  }
  const workerHealth = await checkProvisioningWorkerHealth();
  if (!workerHealth.ok) {
    return Response.json(provisioningWorkerFailureBody(workerHealth), {
      status: workerHealth.status,
    });
  }
  const wake = await provisioningJobService.enqueueAgentWakeOnce({
    agentId: params.agentId,
    organizationId: params.user.organization_id,
    userId: params.user.id,
  });
  void provisioningJobService.triggerImmediate(params.ctx.env).catch(() => {
    // error-policy:J5 the provisioning service logs trigger failures; the
    // durable wake job remains observable and retryable through its id.
  });
  return Response.json(
    {
      success: false,
      code: "workflow_runtime_waking",
      error:
        "The dedicated agent is waking. Retry the workflow request when the wake job completes.",
      capability: "workflows",
      currentExecutionTier: "dedicated-lazy",
      retryable: true,
      wake: {
        jobId: wake.job.id,
        status: wake.job.status,
        created: wake.created,
      },
      polling: {
        endpoint: `/api/v1/jobs/${encodeURIComponent(wake.job.id)}`,
        intervalMs: 5000,
      },
    },
    { status: 503 },
  );
}

async function forwardWorkflowToAgentServer(params: {
  ctx: AppContext;
  request: Request;
  agentId: string;
  runtimeAgentId: string | null;
  suffix: string;
  user: { id: string; organization_id: string };
  executionTier: WorkflowAgentExecutionTier;
  runtimeStatus: string;
  canWakeRuntime: boolean;
}): Promise<Response> {
  // Tier and durable runtime state are authoritative. Redis assignment keys can
  // outlive a stopped process, so consulting them first can bypass both the
  // shared-tier capability response and the paid-compute wake gate.
  if (params.executionTier === "shared") {
    return workflowRuntimeUnavailableResponse(
      params.agentId,
      params.executionTier,
    );
  }
  if (
    params.executionTier === "dedicated-lazy" &&
    DEDICATED_LAZY_INACTIVE_STATUSES.has(params.runtimeStatus)
  ) {
    return wakeDedicatedLazyRuntime(params);
  }

  const routing = await resolveAgentServerRouting(
    createWorkflowRoutingReader(params.ctx),
    {
      managedAgentId: params.agentId,
      runtimeAgentId: params.runtimeAgentId ?? "",
    },
  );
  if (routing.kind !== "ready") {
    if (params.executionTier === "dedicated-lazy" && params.canWakeRuntime) {
      return wakeDedicatedLazyRuntime(params);
    }
    return workflowRuntimeUnavailableResponse(
      params.agentId,
      params.executionTier,
    );
  }

  const sharedSecret = envString(params.ctx, "AGENT_SERVER_SHARED_SECRET");
  if (!sharedSecret) {
    return Response.json(
      {
        success: false,
        code: "workflow_runtime_unavailable",
        error: "The agent workflow runtime is temporarily unavailable.",
        capability: "workflows",
        currentExecutionTier: params.executionTier,
        upgradeRequired: false,
        retryable: true,
      },
      { status: 503 },
    );
  }

  const headers = new Headers(params.request.headers);
  headers.delete("host");
  headers.set("x-server-token", sharedSecret);
  headers.set("x-eliza-user-id", params.user.id);
  headers.set("x-eliza-organization-id", params.user.organization_id);

  const method = params.request.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await params.request.arrayBuffer();
  return fetch(
    buildTargetUrl(
      routing.serverUrl,
      params.request.url,
      routing.runtimeAgentId,
      params.suffix,
    ),
    {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(
        workflowProxyTimeoutMs(method, params.suffix),
      ),
    },
  );
}

export async function handleWorkflowProxyRequest(
  request: Request,
  agentId: string,
  suffix: string,
  ctx: AppContext,
): Promise<Response> {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    // Confirm the caller's org owns this agent before proxying — otherwise any
    // authenticated user could drive workflow ops (suspend/resume/state) on
    // another org's agent just by knowing its id. Matches the suspend/resume
    // routes, which gate on getAgent(agentId, organization_id).
    const agent = await elizaSandboxService.getAgent(
      agentId,
      user.organization_id,
    );
    if (!agent) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Agent not found" },
          { status: 404 },
        ),
        WORKFLOW_CORS_METHODS,
      );
    }
    const forwarded = await forwardWorkflowToAgentServer({
      ctx,
      request,
      agentId: agent.id,
      runtimeAgentId: agent.character_id,
      suffix,
      user,
      executionTier: agent.execution_tier,
      runtimeStatus: agent.status,
      canWakeRuntime: !(
        agent.status === "running" &&
        agent.bridge_url &&
        agent.health_url
      ),
    });
    return applyCorsHeaders(forwarded, WORKFLOW_CORS_METHODS);
  } catch (error) {
    // error-policy:J1 this is the outer Cloud transport boundary; translate
    // authentication, ownership, and proxy failures into the standard response.
    return applyCorsHeaders(errorToResponse(error), WORKFLOW_CORS_METHODS);
  }
}

export function handleWorkflowProxyOptions(): Response {
  return handleCorsOptions(WORKFLOW_CORS_METHODS);
}
