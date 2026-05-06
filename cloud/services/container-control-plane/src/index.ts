import { type Context, Hono } from "hono";
import { dockerNodesRepository } from "@/db/repositories/docker-nodes";
import { containersEnv } from "@/lib/config/containers-env";
import {
  type CreateContainerInput,
  getHetznerContainersClient,
  HetznerClientError,
} from "@/lib/services/containers/hetzner-client";
import { dockerNodeManager } from "@/lib/services/docker-node-manager";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";

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
    return await fn();
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response(JSON.stringify(errorBody(error)), {
      status: errorStatus(error),
      headers: { "content-type": "application/json" },
    });
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
    const syncChanges = await dockerNodeManager.syncAllocatedCounts();
    const image = containersEnv.defaultAgentImage();
    const prePullEnabled = process.env.ELIZA_AGENT_HOT_POOL_PREPULL !== "false";
    const nodes = prePullEnabled
      ? await dockerNodeManager.prePullAgentImageOnAvailableNodes(image)
      : [];
    const capacity = await dockerNodeManager.getCapacityReport();

    return c.json({
      success: true,
      data: {
        image,
        prePullEnabled,
        syncedAllocatedCounts: Object.fromEntries(syncChanges),
        capacity,
        nodes,
        timestamp: new Date().toISOString(),
      },
    });
  });
}

app.get("/api/v1/cron/agent-hot-pool", agentHotPoolResponse);

app.post("/api/v1/cron/agent-hot-pool", agentHotPoolResponse);

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
Bun.serve({
  fetch: app.fetch,
  hostname: process.env.HOST ?? "127.0.0.1",
  port,
});

console.log(`[container-control-plane] listening on ${process.env.HOST ?? "127.0.0.1"}:${port}`);
