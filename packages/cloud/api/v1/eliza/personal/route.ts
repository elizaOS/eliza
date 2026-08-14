/**
 * Read-only account status for the user's one personal Eliza. This endpoint
 * does not touch chat history or start compute, so the signed-in control plane
 * remains useful during Shared or Dedicated runtime outages.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { resolvePersonalElizaIdentity } from "@/lib/services/shared-runtime/personal-eliza-identity";
import { personalSharedAgent } from "@/lib/services/shared-runtime/personal-shared-agent";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const personalEliza = personalSharedAgent({
      userId: user.id,
      organizationId: user.organization_id,
    });
    const identity = await resolvePersonalElizaIdentity(
      personalEliza,
      c.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
    );
    return c.json({ success: true, data: { identity } });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
