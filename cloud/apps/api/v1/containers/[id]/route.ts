/**
 * Container detail / mutation endpoints.
 *
 * GET    /api/v1/containers/[id] — DB-only read, Workers-safe. Supports
 *   `?include=deployments,metrics,logs` to fold related panels into a
 *   single response. Only `deployments` returns real data on the Worker;
 *   `metrics` and `logs` require the Hetzner-Docker SSH client and are
 *   served by the Node sidecar through their dedicated subroutes, so when
 *   requested via `include` the Worker echoes the same `not_yet_migrated`
 *   marker the dedicated routes use.
 * DELETE /api/v1/containers/[id] — forwarded to the Node container control
 *   plane. Tearing down a container requires the Hetzner-Docker SSH client.
 * PATCH  /api/v1/containers/[id] — forwarded to the Node container control
 *   plane. Restart / env / scale all go through the SSH client.
 *
 * The Node sidecar serves DELETE/PATCH; see `cloud/CONTAINERS_MIGRATION.md`.
 */

import { Hono } from "hono";
import { usageRecordsRepository } from "@/db/repositories/usage-records";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { containersService, getContainer } from "@/lib/services/containers";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { forwardToContainerControlPlane } from "../../_container-control-plane-forward";

const app = new Hono<AppEnv>();

const SIDECAR_NOT_MIGRATED = {
  not_yet_migrated: true,
  reason: "Served by the Node sidecar over SSH; not available from this Worker.",
} as const;

interface DeploymentMetadata {
  container_id?: string;
  container_name?: string;
  desired_count?: string;
  cpu?: string;
  memory?: string;
  port?: string;
}

type ContainerRecord = NonNullable<Awaited<ReturnType<typeof getContainer>>>;

async function buildDeployments(container: ContainerRecord, organizationId: string) {
  const allRecords = await usageRecordsRepository.listByOrganization(organizationId, 50);
  const containerDeployments = allRecords
    .filter((record) => record.type === "container_deployment")
    .filter((record) => {
      const metadata = (record.metadata as DeploymentMetadata | null) ?? {};
      return metadata.container_id === container.id || metadata.container_name === container.name;
    });

  return {
    container: {
      id: container.id,
      name: container.name,
      current_status: container.status,
      load_balancer_url: container.load_balancer_url,
      node_id: container.node_id,
    },
    deployments: containerDeployments.map((deployment) => {
      const metadata = (deployment.metadata as DeploymentMetadata | null) ?? {};
      let status: "success" | "failed" | "pending";
      if (deployment.is_successful) status = "success";
      else if (deployment.error_message) status = "failed";
      else status = "pending";

      return {
        id: deployment.id,
        status,
        cost: deployment.input_cost,
        error: deployment.error_message,
        metadata: {
          container_id: metadata.container_id,
          container_name: metadata.container_name,
          desired_count: metadata.desired_count,
          cpu: metadata.cpu,
          memory: metadata.memory,
          port: metadata.port,
          image_tag: container.image_tag,
          node_id: container.node_id,
        },
        deployed_at: deployment.created_at,
        duration_ms: deployment.duration_ms,
      };
    }),
    total: containerDeployments.length,
  };
}

const VALID_INCLUDES = new Set(["deployments", "metrics", "logs"]);

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const containerId = c.req.param("id");
    if (!containerId) {
      return c.json({ success: false, error: "Container id required" }, 400);
    }

    const container = await containersService.getById(containerId, user.organization_id);
    if (!container) {
      return c.json({ success: false, error: "Container not found" }, 404);
    }

    const includeParam = c.req.query("include");
    if (!includeParam) {
      return c.json({ success: true, data: container });
    }

    const requested = includeParam
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    for (const v of requested) {
      if (!VALID_INCLUDES.has(v)) {
        return c.json(
          {
            success: false,
            error: `Invalid include value "${v}". Valid: ${Array.from(VALID_INCLUDES).join(", ")}`,
          },
          400,
        );
      }
    }

    const want = new Set(requested);

    const deployments = want.has("deployments")
      ? await buildDeployments(container, user.organization_id)
      : undefined;

    const data: {
      container: typeof container;
      deployments?: Awaited<ReturnType<typeof buildDeployments>>;
      metrics?: typeof SIDECAR_NOT_MIGRATED;
      logs?: typeof SIDECAR_NOT_MIGRATED;
    } = { container };

    if (deployments) data.deployments = deployments;
    if (want.has("metrics")) data.metrics = SIDECAR_NOT_MIGRATED;
    if (want.has("logs")) data.logs = SIDECAR_NOT_MIGRATED;

    return c.json({ success: true, data });
  } catch (error) {
    logger.error("[Containers API] get error:", error);
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    return forwardToContainerControlPlane(c, user);
  } catch (error) {
    logger.error("[Containers API] delete forward error:", error);
    return failureResponse(c, error);
  }
});

app.patch("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    return forwardToContainerControlPlane(c, user);
  } catch (error) {
    logger.error("[Containers API] patch forward error:", error);
    return failureResponse(c, error);
  }
});

export default app;
