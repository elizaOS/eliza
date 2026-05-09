import { userCharactersRepository } from "@elizaos/cloud-db/repositories/characters";
import {
  type DockerNode,
  dockerNodesRepository,
} from "@elizaos/cloud-db/repositories/docker-nodes";
import { containersEnv } from "@elizaos/cloud-lib/config/containers-env";
import {
  envelope,
  errorEnvelope,
  toCompatOpResult,
} from "@elizaos/cloud-lib/internal/api/compat-envelope";
import { runWithCloudBindingsAsync } from "@elizaos/cloud-lib/internal/runtime/cloud-bindings";
import { WarmPoolManager } from "@elizaos/cloud-lib/internal/services/containers/agent-warm-pool";
import { getHetznerPoolContainerCreator } from "@elizaos/cloud-lib/internal/services/containers/agent-warm-pool-creator";
import {
  type CreateContainerInput,
  getHetznerContainersClient,
  HetznerClientError,
} from "@elizaos/cloud-lib/internal/services/containers/hetzner-client";
import { getNodeAutoscaler } from "@elizaos/cloud-lib/internal/services/containers/node-autoscaler";
import { dockerNodeManager } from "@elizaos/cloud-lib/internal/services/docker-node-manager";
import { reusesExistingElizaCharacter } from "@elizaos/cloud-lib/internal/services/eliza-agent-config";
import type { BridgeRequest } from "@elizaos/cloud-lib/internal/services/eliza-sandbox";
import { elizaSandboxService } from "@elizaos/cloud-lib/internal/services/eliza-sandbox";
import { provisioningJobService } from "@elizaos/cloud-lib/internal/services/provisioning-jobs";
import { logger } from "@elizaos/cloud-lib/utils/logger";
import { type Context, Hono } from "hono";

let cachedWarmPoolManager: WarmPoolManager | null = null;
function getWarmPoolManager(): WarmPoolManager {
  if (!cachedWarmPoolManager) {
    cachedWarmPoolManager = new WarmPoolManager(getHetznerPoolContainerCreator());
  }
  return cachedWarmPoolManager;
}

interface ForwardedAuth {
  userId: string;
  organizationId: string;
}

const app = new Hono();
const client = getHetznerContainersClient();

function errorStatus(error: unknown): number {
  if (error instanceof HetznerClientError) {
    switch (error.code) {
      case "container_not_found":
        return 404;
      case "invalid_input":
        return 400;
      case "no_capacity":
        return 503;
      case "image_pull_failed":
      case "container_create_failed":
      case "container_stop_failed":
      case "ssh_unreachable":
        return 502;
    }
  }
  return 500;
}

function errorBody(error: unknown) {
  return {
    success: false,
    code: error instanceof HetznerClientError ? error.code : "container_control_plane_error",
    error: error instanceof Error ? error.message : String(error),
  };
}

function requireForwardedAuth(c: Context): ForwardedAuth {
  requireInternalToken(c);

  const userId = c.req.header("x-eliza-user-id")?.trim();
  const organizationId = c.req.header("x-eliza-organization-id")?.trim();
  if (!userId || !organizationId) {
    throw new Response(
      JSON.stringify({
        success: false,
        error: "Missing forwarded user or organization headers",
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  return { userId, organizationId };
}

function requireInternalToken(c: Context): void {
  const expectedToken = process.env.CONTAINER_CONTROL_PLANE_TOKEN?.trim();
  if (expectedToken) {
    const supplied = c.req.header("x-container-control-plane-token")?.trim();
    if (supplied !== expectedToken) {
      throw new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
  }
}

function asRecordOfStrings(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HetznerClientError("invalid_input", "environment_vars must be an object");
  }
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") {
      throw new HetznerClientError("invalid_input", `environment_vars.${key} must be a string`);
    }
    out[key] = rawValue;
  }
  return out;
}

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new HetznerClientError("invalid_input", `${key} is required`);
  }
  return value.trim();
}

function readOptionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(body: Record<string, unknown>, key: string, fallback: number): number {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HetznerClientError("invalid_input", `${key} must be a number`);
  }
  return parsed;
}

function readBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HetznerClientError("invalid_input", `${key} must be a boolean`);
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HetznerClientError("invalid_input", "JSON object body required");
  }
  return body as Record<string, unknown>;
}

function toCreateInput(body: Record<string, unknown>, auth: ForwardedAuth): CreateContainerInput {
  return {
    name: readString(body, "name"),
    projectName: readString(body, "project_name"),
    description: readOptionalString(body, "description"),
    organizationId: auth.organizationId,
    userId: auth.userId,
    apiKeyId: readOptionalString(body, "api_key_id") ?? null,
    image: readString(body, "image"),
    port: readNumber(body, "port", 3000),
    desiredCount: readNumber(body, "desired_count", 1),
    cpu: readNumber(body, "cpu", 256),
    memoryMb: readNumber(body, "memory", 512),
    healthCheckPath: readOptionalString(body, "health_check_path") ?? "/health",
    environmentVars: asRecordOfStrings(body.environment_vars),
    persistVolume: readBoolean(body, "persist_volume") ?? false,
    useHetznerVolume: readBoolean(body, "use_hetzner_volume") ?? false,
    volumeSizeGb: readNumber(body, "volume_size_gb", 10),
  };
}

async function handle(c: Context, fn: (auth: ForwardedAuth) => Promise<Response>) {
  try {
    const auth = requireForwardedAuth(c);
    const databaseUrl = c.req.header("x-eliza-cloud-database-url")?.trim();
    if (databaseUrl) {
      const controlPlaneNodes = await dockerNodesRepository.findAll();
      return await runWithCloudBindingsAsync({ DATABASE_URL: databaseUrl }, async () => {
        await mirrorControlPlaneNodes(controlPlaneNodes);
        return await fn(auth);
      });
    }
    return await fn(auth);
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response(JSON.stringify(errorBody(error)), {
      status: errorStatus(error),
      headers: { "content-type": "application/json" },
    });
  }
}

async function handleInternal(c: Context, fn: () => Promise<Response>) {
  try {
    requireInternalToken(c);
    const databaseUrl = c.req.header("x-eliza-cloud-database-url")?.trim();
    if (databaseUrl) {
      const controlPlaneNodes = await dockerNodesRepository.findAll();
      return await runWithCloudBindingsAsync({ DATABASE_URL: databaseUrl }, async () => {
        await mirrorControlPlaneNodes(controlPlaneNodes);
        return await fn();
      });
    }
    return await fn();
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response(JSON.stringify(errorBody(error)), {
      status: errorStatus(error),
      headers: { "content-type": "application/json" },
    });
  }
}

async function mirrorControlPlaneNodes(nodes: DockerNode[]): Promise<void> {
  for (const node of nodes) {
    const data = {
      node_id: node.node_id,
      hostname: node.hostname,
      ssh_port: node.ssh_port,
      capacity: node.capacity,
      enabled: node.enabled,
      status: node.status,
      last_health_check: node.last_health_check,
      ssh_user: node.ssh_user,
      host_key_fingerprint: node.host_key_fingerprint,
      metadata: node.metadata,
    };

    const existing = await dockerNodesRepository.findByNodeId(node.node_id);
    if (existing) {
      await dockerNodesRepository.update(existing.id, data);
    } else {
      await dockerNodesRepository.create({
        ...data,
        allocated_count: 0,
      });
    }
  }
}

app.get("/health", (c) => c.json({ success: true, service: "container-control-plane" }));

function deploymentMonitorResponse(c: Context) {
  return handleInternal(c, async () => {
    const result = await client.monitorInflight();
    return c.json({
      success: true,
      data: { ...result, timestamp: new Date().toISOString() },
    });
  });
}

app.get("/api/v1/cron/deployment-monitor", deploymentMonitorResponse);

app.post("/api/v1/cron/deployment-monitor", deploymentMonitorResponse);

function agentHotPoolResponse(c: Context) {
  return handleInternal(c, async () => {
    const healthChecks = await dockerNodeManager.healthCheckAll();
    const syncChanges = await dockerNodeManager.syncAllocatedCounts();
    const image = containersEnv.defaultAgentImage();
    const prePullEnabled = process.env.ELIZA_AGENT_HOT_POOL_PREPULL !== "false";
    const nodes = prePullEnabled
      ? await dockerNodeManager.prePullAgentImageOnAvailableNodes(image)
      : [];
    const capacity = await dockerNodeManager.getCapacityReport();
    const failedPrePulls = nodes.filter((node) => node.status === "failed");
    const noSuccessfulPrePulls =
      prePullEnabled && nodes.length > 0 && failedPrePulls.length === nodes.length;

    return c.json(
      {
        success: !noSuccessfulPrePulls,
        ...(noSuccessfulPrePulls
          ? {
              code: "AGENT_HOT_POOL_PREPULL_FAILED",
              error: "Agent image pre-pull failed on every eligible Docker node.",
            }
          : {}),
        data: {
          image,
          prePullEnabled,
          healthChecks: Object.fromEntries(healthChecks),
          syncedAllocatedCounts: Object.fromEntries(syncChanges),
          capacity,
          nodes,
          timestamp: new Date().toISOString(),
        },
      },
      noSuccessfulPrePulls ? 502 : 200,
    );
  });
}

app.get("/api/v1/cron/agent-hot-pool", agentHotPoolResponse);

app.post("/api/v1/cron/agent-hot-pool", agentHotPoolResponse);

function nodeAutoscaleResponse(c: Context) {
  return handleInternal(c, async () => {
    const autoscaler = getNodeAutoscaler();
    const decision = await autoscaler.evaluateCapacity();
    const result: Record<string, unknown> = {
      ...decision,
      actions: [] as Array<Record<string, unknown>>,
      timestamp: new Date().toISOString(),
    };

    if (!decision.shouldScaleUp && decision.shouldScaleDownNodeIds.length === 0) {
      return c.json({
        success: true,
        data: { ...result, action: "noop" },
      });
    }

    if (decision.shouldScaleUp) {
      const hcloudToken = containersEnv.hetznerCloudToken();
      const publicKey = process.env.CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY?.trim();

      if (!hcloudToken) {
        (result.actions as Array<Record<string, unknown>>).push({
          type: "scale_up_skipped",
          reason: "HCLOUD_TOKEN not configured",
        });
      } else if (!publicKey) {
        (result.actions as Array<Record<string, unknown>>).push({
          type: "scale_up_skipped",
          reason: "CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY not configured",
        });
      } else {
        try {
          const provisioned = await autoscaler.provisionNode(
            {},
            {
              controlPlanePublicKey: publicKey,
              registrationUrl: process.env.CONTAINERS_BOOTSTRAP_CALLBACK_URL,
              registrationSecret: process.env.CONTAINERS_BOOTSTRAP_SECRET,
            },
          );
          (result.actions as Array<Record<string, unknown>>).push({
            type: "provisioned",
            nodeId: provisioned.nodeId,
            hostname: provisioned.hostname,
            hcloudServerId: provisioned.hcloudServerId,
          });
        } catch (error) {
          (result.actions as Array<Record<string, unknown>>).push({
            type: "scale_up_failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (decision.shouldScaleDownNodeIds.length > 0) {
      const target = decision.shouldScaleDownNodeIds[0]!;
      try {
        await autoscaler.drainNode(target, { deprovision: true });
        (result.actions as Array<Record<string, unknown>>).push({
          type: "drained",
          nodeId: target,
        });
      } catch (error) {
        (result.actions as Array<Record<string, unknown>>).push({
          type: "drain_failed",
          nodeId: target,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return c.json({ success: true, data: result });
  });
}

app.get("/api/v1/cron/node-autoscale", nodeAutoscaleResponse);

app.post("/api/v1/cron/node-autoscale", nodeAutoscaleResponse);

function processProvisioningJobsResponse(c: Context) {
  return handleInternal(c, async () => {
    const rawLimit = Number(c.req.query("limit") ?? "5");
    const batchSize = Number.isFinite(rawLimit) ? Math.max(1, Math.min(25, rawLimit)) : 5;
    const result = await provisioningJobService.processPendingJobs(batchSize);
    return c.json({
      success: true,
      data: {
        ...result,
        batchSize,
        timestamp: new Date().toISOString(),
      },
    });
  });
}

app.get("/api/v1/cron/process-provisioning-jobs", processProvisioningJobsResponse);

app.post("/api/v1/cron/process-provisioning-jobs", processProvisioningJobsResponse);

// ── Warm pool ─────────────────────────────────────────────────────────────

function poolReplenishResponse(c: Context) {
  return handleInternal(c, async () => {
    const image = containersEnv.defaultAgentImage();
    const result = await getWarmPoolManager().replenish(image);
    return c.json({
      success: true,
      data: {
        image,
        ...result,
        timestamp: new Date().toISOString(),
      },
    });
  });
}
app.get("/api/v1/cron/pool-replenish", poolReplenishResponse);
app.post("/api/v1/cron/pool-replenish", poolReplenishResponse);

function poolDrainIdleResponse(c: Context) {
  return handleInternal(c, async () => {
    const image = containersEnv.defaultAgentImage();
    const result = await getWarmPoolManager().drainIdle(image);
    return c.json({
      success: true,
      data: { image, ...result, timestamp: new Date().toISOString() },
    });
  });
}
app.get("/api/v1/cron/pool-drain-idle", poolDrainIdleResponse);
app.post("/api/v1/cron/pool-drain-idle", poolDrainIdleResponse);

function poolHealthCheckResponse(c: Context) {
  return handleInternal(c, async () => {
    const result = await getWarmPoolManager().healthCheck();
    return c.json({
      success: true,
      data: { ...result, timestamp: new Date().toISOString() },
    });
  });
}
app.get("/api/v1/cron/pool-health-check", poolHealthCheckResponse);
app.post("/api/v1/cron/pool-health-check", poolHealthCheckResponse);

function poolImageRolloutResponse(c: Context) {
  return handleInternal(c, async () => {
    const image = containersEnv.defaultAgentImage();
    const result = await getWarmPoolManager().rollout(image);
    return c.json({
      success: true,
      data: { image, ...result, timestamp: new Date().toISOString() },
    });
  });
}
app.get("/api/v1/cron/pool-image-rollout", poolImageRolloutResponse);
app.post("/api/v1/cron/pool-image-rollout", poolImageRolloutResponse);

function poolStateResponse(c: Context) {
  return handleInternal(c, async () => {
    const image = containersEnv.defaultAgentImage();
    const state = await getWarmPoolManager().snapshot(image);
    return c.json({
      success: true,
      data: {
        image,
        enabled: containersEnv.warmPoolEnabled(),
        minPoolSize: containersEnv.warmPoolMinSize(),
        maxPoolSize: containersEnv.warmPoolMaxSize(),
        state,
        timestamp: new Date().toISOString(),
      },
    });
  });
}
app.get("/api/v1/admin/warm-pool", poolStateResponse);

app.post("/api/v1/admin/docker-nodes/:nodeId/health-check", (c) =>
  handle(c, async () => {
    const nodeId = c.req.param("nodeId");
    const node = await dockerNodesRepository.findByNodeId(nodeId);
    if (!node) {
      return c.json({ success: false, error: `Node '${nodeId}' not found` }, 404);
    }

    const status = await dockerNodeManager.healthCheckNode(node);
    const updated = await dockerNodesRepository.findByNodeId(nodeId);
    return c.json({
      success: true,
      data: {
        nodeId,
        status,
        node: updated,
      },
    });
  }),
);

app.delete("/api/compat/agents/:id", (c) =>
  handle(c, async (auth) => {
    const agentId = c.req.param("id");
    const deleted = await elizaSandboxService.deleteAgent(agentId, auth.organizationId);
    if (!deleted.success) {
      const status =
        deleted.error === "Agent not found"
          ? 404
          : deleted.error === "Agent provisioning is in progress"
            ? 409
            : 500;
      return c.json(errorEnvelope(deleted.error), status);
    }

    const characterId = deleted.deletedSandbox.character_id;
    const sandboxConfig = deleted.deletedSandbox.agent_config as Record<string, unknown> | null;
    const reusesExistingCharacter = reusesExistingElizaCharacter(sandboxConfig);

    if (characterId && !reusesExistingCharacter) {
      try {
        await userCharactersRepository.delete(characterId);
      } catch (charErr) {
        logger.warn(
          "[container-control-plane] Failed linked character cleanup after agent delete",
          {
            agentId,
            characterId,
            error: charErr instanceof Error ? charErr.message : String(charErr),
          },
        );
      }
    }

    return c.json(envelope(toCompatOpResult(agentId, "delete", true)));
  }),
);

app.post("/api/v1/eliza/agents/:id/bridge", (c) =>
  handle(c, async (auth) => {
    const agentId = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as BridgeRequest | null;
    if (!body || typeof body !== "object" || body.jsonrpc !== "2.0" || !body.method) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32600, message: "Invalid JSON-RPC request" },
        },
        400,
      );
    }

    const response = await elizaSandboxService.bridge(agentId, auth.organizationId, body);
    return c.json(response);
  }),
);

app.post("/api/v1/eliza/agents/:id/stream", (c) =>
  handle(c, async (auth) => {
    const agentId = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as BridgeRequest | null;
    const streamHeaders = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    };

    if (
      !body ||
      typeof body !== "object" ||
      body.jsonrpc !== "2.0" ||
      body.method !== "message.send"
    ) {
      return new Response(
        `event: error\ndata: ${JSON.stringify({ message: "Invalid JSON-RPC stream request" })}\n\n`,
        { status: 400, headers: streamHeaders },
      );
    }

    const response = await elizaSandboxService.bridgeStream(agentId, auth.organizationId, body);
    if (!response?.body) {
      return new Response(
        `event: error\ndata: ${JSON.stringify({ message: "Sandbox is not running or unreachable" })}\n\n`,
        { status: 200, headers: streamHeaders },
      );
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: streamHeaders,
    });
  }),
);

app.post("/api/v1/containers", (c) =>
  handle(c, async (auth) => {
    const body = await readJsonObject(c);
    const created = await client.createContainer(toCreateInput(body, auth));

    await client.monitorInflight().catch((error) => {
      console.warn(
        "[container-control-plane] immediate deployment monitor failed",
        error instanceof Error ? error.message : String(error),
      );
    });

    const data = (await client.getContainer(created.id, auth.organizationId)) ?? created;
    return c.json(
      {
        success: true,
        data,
        polling: {
          endpoint: `/api/v1/containers/${data.id}`,
          intervalMs: 5000,
          expectedDurationMs: 120000,
        },
      },
      201,
    );
  }),
);

app.get("/api/v1/containers/:id", (c) =>
  handle(c, async (auth) => {
    const data = await client.getContainer(c.req.param("id"), auth.organizationId);
    if (!data) {
      return c.json({ success: false, error: "Container not found" }, 404);
    }
    return c.json({ success: true, data });
  }),
);

app.delete("/api/v1/containers/:id", (c) =>
  handle(c, async (auth) => {
    await client.deleteContainer(c.req.param("id"), auth.organizationId);
    return c.json({ success: true });
  }),
);

app.patch("/api/v1/containers/:id", (c) =>
  handle(c, async (auth) => {
    const body = await readJsonObject(c);
    const containerId = c.req.param("id");
    if (body.environment_vars !== undefined) {
      const data = await client.setEnv(
        containerId,
        auth.organizationId,
        asRecordOfStrings(body.environment_vars) ?? {},
      );
      return c.json({ success: true, data });
    }
    if (body.desired_count !== undefined) {
      await client.setScale(containerId, auth.organizationId, readNumber(body, "desired_count", 1));
      const data = await client.getContainer(containerId, auth.organizationId);
      return c.json({ success: true, data });
    }
    if (body.action === "restart" || body.status === "restarting") {
      const data = await client.restartContainer(containerId, auth.organizationId);
      return c.json({ success: true, data });
    }
    throw new HetznerClientError(
      "invalid_input",
      "PATCH supports environment_vars, desired_count, or action=restart",
    );
  }),
);

app.get("/api/v1/containers/:id/logs", (c) =>
  handle(c, async (auth) => {
    const tail = Number(c.req.query("tail") ?? "200");
    const logs = await client.tailLogs(c.req.param("id"), auth.organizationId, tail);
    return c.text(logs, 200, { "content-type": "text/plain; charset=utf-8" });
  }),
);

app.get("/api/v1/containers/:id/metrics", (c) =>
  handle(c, async (auth) => {
    const data = await client.getMetrics(c.req.param("id"), auth.organizationId);
    return c.json({ success: true, data });
  }),
);

app.all("*", (c) => c.json({ success: false, error: "Not found" }, 404));

const port = Number(process.env.PORT ?? process.env.CONTAINER_CONTROL_PLANE_PORT ?? 8791);
const idleTimeout = Math.min(
  255,
  Math.max(1, Number(process.env.CONTAINER_CONTROL_PLANE_IDLE_TIMEOUT_SECONDS ?? 255)),
);
Bun.serve({
  fetch: app.fetch,
  hostname: process.env.HOST ?? "127.0.0.1",
  idleTimeout,
  port,
});

console.log(`[container-control-plane] listening on ${process.env.HOST ?? "127.0.0.1"}:${port}`);
