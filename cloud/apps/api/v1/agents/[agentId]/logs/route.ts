/**
 * GET /api/v1/agents/[agentId]/logs
 *
 * Service-to-service: fetch container logs via the bridge URL.
 * Auth: X-Service-Key header.
 *
 * Query params:
 *   tail - number of log lines to return (default 100)
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const identity = await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";
    const agent = await elizaSandboxService.getAgent(agentId, identity.organizationId);

    if (!agent) {
      return c.json({ error: "Agent not found" }, 404);
    }

    const rawTail = parseInt(c.req.query("tail") ?? "100", 10);
    const tail = Math.max(1, Math.min(Number.isFinite(rawTail) ? rawTail : 100, 5000));

    if (agent.bridge_url && agent.status === "running") {
      try {
        const logsUrl = `${agent.bridge_url}/logs?tail=${tail}`;
        await assertSafeOutboundUrl(logsUrl);
        const res = await fetch(logsUrl, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          const logs = await res.text();
          return c.json({ logs, status: agent.status });
        }
      } catch (fetchErr) {
        logger.warn("[service-api] Failed to fetch logs from bridge", {
          agentId,
          error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
        });
      }
    }

    return c.json({
      logs: null,
      status: agent.status,
      message:
        agent.status === "running"
          ? "Agent is running but logs are unavailable"
          : `Agent is ${agent.status}`,
      errorMessage: agent.error_message ?? null,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
