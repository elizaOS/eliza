/**
 * Reports whether the signed-in organization may publish a container backend.
 *
 * The verdict combines the global trigger and production org allowlist so
 * clients can present the container choice honestly before creating a Cloud
 * record; the deploy POST remains the authoritative enforcement boundary.
 */

import { Hono } from "hono";
import { appsDeployCapability } from "@/api-app/lib/apps-deploy-gate";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    return c.json(appsDeployCapability(c.env, user.organization_id));
  } catch (error) {
    // error-policy:J1 authenticated HTTP boundary translates to the Cloud error envelope.
    logger.error("[Apps Deploy Capability] Failed to resolve capability", {
      error,
    });
    return failureResponse(c, error);
  }
});

export default app;
