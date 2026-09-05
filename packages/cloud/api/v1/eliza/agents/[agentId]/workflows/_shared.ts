/**
 * Authenticates Cloud workflow requests, verifies agent ownership, and proxies
 * them to the assigned agent server. When no compatible runtime is assigned,
 * callers receive a typed dedicated-upgrade or retryable-unavailable response.
 */
import type { AgentExecutionTier } from "@elizaos/shared/contracts/cloud-agent-lifecycle";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { buildRedisClient } from "@/lib/cache/redis-factory";
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

export function workflowRuntimeUnavailableResponse(
  agentId: string,
  executionTier: AgentExecutionTier,
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

async function resolveAgentServerUrl(
  c: AppContext,
  agentId: string,
): Promise<string | null> {
  const redis = buildRedisClient(c.env);
  if (!redis) return null;

  const serverName = await redis.get<string>(`agent:${agentId}:server`);
  if (!serverName) return null;

  const serverUrl = await redis.get<string>(`server:${serverName}:url`);
  return typeof serverUrl === "string" && serverUrl.trim()
    ? serverUrl.trim()
    : null;
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
  suffix: string;
  user: { id: string; organization_id: string };
  executionTier: AgentExecutionTier;
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

  const serverUrl = await resolveAgentServerUrl(params.ctx, params.agentId);
  if (!serverUrl) {
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
      serverUrl,
      params.request.url,
      params.agentId,
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
      agentId,
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
