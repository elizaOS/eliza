/**
 * GET /api/v1/containers/[id]/deployments
 * Deployment history for a container, drawn from usage records. Pure DB.
 */

import { Hono } from "hono";
import { usageRecordsRepository } from "@/db/repositories/usage-records";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { containersService } from "@/lib/services/containers";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface DeploymentMetadata {
  container_id?: string;
  container_name?: string;
  desired_count?: string;
  cpu?: string;
  memory?: string;
  port?: string;
}

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Container id required" }, 400);
    }

    const container = await containersService.getById(id, user.organization_id);
    if (!container) {
      return c.json({ success: false, error: "Container not found" }, 404);
    }

    // Filtering happens in memory because we need to match on a metadata
    // jsonb field; a dedicated repository method would be cleaner.
    const allRecords = await usageRecordsRepository.listByOrganization(user.organization_id, 50);
    const deployments = allRecords.filter((record) => record.type === "container_deployment");

    const containerDeployments = deployments.filter((d) => {
      const metadata = (d.metadata as DeploymentMetadata | null) ?? {};
      return metadata.container_id === id || metadata.container_name === container.name;
    });

    const enhancedHistory = containerDeployments.map((deployment) => {
      const metadata = (deployment.metadata as DeploymentMetadata | null) ?? {};

      let status: "success" | "failed" | "pending";
      if (deployment.is_successful) {
        status = "success";
      } else if (deployment.error_message) {
        status = "failed";
      } else {
        status = "pending";
      }

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
    });

    return c.json({
      success: true,
      data: {
        container: {
          id: container.id,
          name: container.name,
          current_status: container.status,
          load_balancer_url: container.load_balancer_url,
          node_id: container.node_id,
        },
        deployments: enhancedHistory,
        total: enhancedHistory.length,
      },
    });
  } catch (error) {
    logger.error("[Containers API] deployments error:", error);
    return failureResponse(c, error);
  }
});

export default app;
