/**
 * POST /api/v1/apis/streaming/sessions
 *
 * Creates a relay ingest credential bundle for the Eliza agent RTMP client.
 * SRS fan-out is optional; until provisioned this returns a deterministic stub
 * ingest URL from `STREAMING_RELAY_INGEST_BASE` when set.
 */

import { RtmpRelayService } from "@elizaos/cloud-rtmp-relay";
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { creditsService } from "@/lib/services/credits";
import { getServiceMethodCost } from "@/lib/services/proxy/pricing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const createBodySchema = z.object({
  destinations: z.array(z.string().min(1)).min(1),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const { organization_id } = user;

    const raw = await c.req.json().catch(() => null);
    const parsed = createBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid body", details: parsed.error.issues }, 400);
    }

    const cost = await getServiceMethodCost("streaming", "session.create");
    const deduct = await creditsService.deductCredits({
      organizationId: organization_id,
      amount: cost,
      description: "API: streaming — session.create",
      metadata: {
        type: "streaming",
        service: "streaming",
        method: "session.create",
        destinations: parsed.data.destinations,
      },
    });
    if (!deduct.success) {
      return c.json(
        { error: "Insufficient credits", topUpUrl: "https://www.elizacloud.ai/dashboard/billing" },
        402,
      );
    }

    const relay = new RtmpRelayService({
      STREAMING_RELAY_INGEST_BASE:
        typeof c.env.STREAMING_RELAY_INGEST_BASE === "string"
          ? c.env.STREAMING_RELAY_INGEST_BASE
          : undefined,
    });
    const creds = relay.mintStubSession();

    logger.info("[StreamingSessions] created stub relay session", {
      organizationId: organization_id,
      sessionId: creds.sessionId,
      destinationCount: parsed.data.destinations.length,
    });

    return c.json({
      sessionId: creds.sessionId,
      streamKey: creds.streamKey,
      ingestUrl: creds.ingestUrl,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
