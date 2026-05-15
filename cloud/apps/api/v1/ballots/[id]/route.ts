/**
 * Secret ballot — single resource.
 *
 * GET /api/v1/ballots/:id            Authed creator view (full row including tally).
 * GET /api/v1/ballots/:id?public=1   Redacted public view (no token-hash metadata).
 */

import { Hono } from "hono";
import { secretBallotsRepository } from "@/db/repositories/secret-ballots";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  createSecretBallotsService,
  redactSecretBallotForPublic,
} from "@/lib/services/secret-ballots";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Missing ballot id" }, 400);
    }
    const isPublic = c.req.query("public") === "1";
    const service = createSecretBallotsService({ repository: secretBallotsRepository });

    if (isPublic) {
      const row = await secretBallotsRepository.getBallot(id);
      if (!row) {
        return c.json({ success: false, error: "Ballot not found" }, 404);
      }
      return c.json({ success: true, ballot: redactSecretBallotForPublic(row) });
    }

    const user = await requireUserOrApiKeyWithOrg(c);
    const row = await service.get(id, user.organization_id);
    if (!row) {
      return c.json({ success: false, error: "Ballot not found" }, 404);
    }
    return c.json({ success: true, ballot: row });
  } catch (error) {
    logger.error("[SecretBallots API] Failed to get ballot", { error });
    return failureResponse(c, error);
  }
});

export default app;
