/**
 * POST /api/v1/agents/[agentId]/suspend
 *
 * Service-to-service: shutdown a running agent (snapshot + stop).
 * Auth: X-Service-Key header.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireServiceKey } from "@/lib/auth/service-key-hono-worker";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const suspendSchema = z.object({
  reason: z.string().min(1).default("owner requested suspension"),
});

app.post("/", async (c) => {
  try {
    const identity = await requireServiceKey(c);
    const agentId = c.req.param("agentId") ?? "";

    const raw = await c.req.json().catch(() => ({}));
    const parsed = suspendSchema.safeParse(raw);
    const reason = parsed.success ? parsed.data.reason : "owner requested suspension";

    logger.info("[service-api] Suspending agent", { agentId, reason });

    const result = await elizaSandboxService.shutdown(agentId, identity.organizationId);
    if (!result.success) {
      const status =
        result.error === "Agent not found"
          ? 404
          : result.error === "Agent provisioning is in progress"
            ? 409
            : 500;
      return c.json({ success: false, error: result.error }, status);
    }

    return c.json({ success: true }, 200);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
