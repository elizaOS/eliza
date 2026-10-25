/**
 * Authenticated sensitive request cancel endpoint.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  type SensitiveRequestActor,
  sensitiveRequestsService,
} from "@elizaos/cloud-shared/lib/services/sensitive-requests";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

function actorFromUser(
  user: Awaited<ReturnType<typeof requireUserOrApiKeyWithOrg>>,
): SensitiveRequestActor {
  return {
    type: "user",
    userId: user.id,
    organizationId: user.organization_id,
    email: user.email,
  };
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id)
      return c.json({ success: false, error: "Missing request id" }, 400);

    const request = await sensitiveRequestsService.cancel(
      id,
      actorFromUser(user),
    );
    return c.json({ success: true, request });
  } catch (error) {
    logger.error("[SensitiveRequests API] cancel failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
