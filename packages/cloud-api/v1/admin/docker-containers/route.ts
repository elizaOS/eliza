/**
 * Admin Docker Containers API
 *
 * GET /api/v1/admin/docker-containers — List all Docker containers across nodes
 * Requires super_admin role.
 */

import { and, desc, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead } from "@/db/helpers";
import { type AgentSandboxStatus, agentSandboxes } from "@/db/schemas/agent-sandboxes";
import { ForbiddenError, failureResponse, ValidationError } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { getStewardAgent } from "@/lib/services/steward-client";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const STEWARD_ENRICHMENT_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

app.get("/", async (c) => {
  try {
    const { role } = await requireAdmin(c);
    if (role !== "super_admin") throw ForbiddenError("Super admin access required");

    const statusFilter = c.req.query("status");
    const nodeFilter = c.req.query("nodeId");
    const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);

    const conditions: SQL[] = [isNotNull(agentSandboxes.node_id)];

    const VALID_STATUSES = new Set<string>([
      "pending",
      "provisioning",
      "running",
      "stopped",
      "disconnected",
      "error",
    ]);
    if (statusFilter) {
      if (!VALID_STATUSES.has(statusFilter)) {
        throw ValidationError(`Invalid status filter: ${statusFilter}`);
      }
      conditions.push(eq(agentSandboxes.status, statusFilter as AgentSandboxStatus));
    }

    if (nodeFilter) {
      conditions.push(eq(agentSandboxes.node_id, nodeFilter));
    }

    const [countResult] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSandboxes)
      .where(and(...conditions));

    const totalCount = countResult?.count ?? 0;

    const containers = await dbRead
      .select({
        id: agentSandboxes.id,
        sandboxId: agentSandboxes.sandbox_id,
        organizationId: agentSandboxes.organization_id,
        userId: agentSandboxes.user_id,
        agentName: agentSandboxes.agent_name,
        status: agentSandboxes.status,
        nodeId: agentSandboxes.node_id,
        containerName: agentSandboxes.container_name,
        bridgePort: agentSandboxes.bridge_port,
        webUiPort: agentSandboxes.web_ui_port,
        headscaleIp: agentSandboxes.headscale_ip,
        dockerImage: agentSandboxes.docker_image,
        bridgeUrl: agentSandboxes.bridge_url,
        healthUrl: agentSandboxes.health_url,
        lastHeartbeatAt: agentSandboxes.last_heartbeat_at,
        errorMessage: agentSandboxes.error_message,
        errorCount: agentSandboxes.error_count,
        createdAt: agentSandboxes.created_at,
        updatedAt: agentSandboxes.updated_at,
      })
      .from(agentSandboxes)
      .where(and(...conditions))
      .orderBy(desc(agentSandboxes.created_at))
      .limit(limit);

    const enrichedContainers = await mapWithConcurrency(
      containers,
      STEWARD_ENRICHMENT_CONCURRENCY,
      async (item) => {
        let walletAddress: string | null = null;
        let walletProvider: "steward" | null = null;

        if (item.nodeId) {
          try {
            const stewardAgent = await getStewardAgent(item.id, {
              organizationId: item.organizationId,
            });
            if (stewardAgent?.walletAddress) {
              walletAddress = stewardAgent.walletAddress;
              walletProvider = "steward";
            } else {
              walletProvider = "steward";
            }
          } catch {
            // Steward unreachable — leave as null
          }
        }

        return { ...item, walletAddress, walletProvider };
      },
    );

    return c.json({
      success: true,
      data: {
        containers: enrichedContainers,
        total: totalCount,
        returned: containers.length,
        filters: { status: statusFilter, nodeId: nodeFilter, limit },
      },
    });
  } catch (error) {
    logger.error("[Admin Docker Containers] Failed to list containers", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failureResponse(c, error);
  }
});

export default app;
