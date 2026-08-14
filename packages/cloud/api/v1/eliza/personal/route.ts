/**
 * Read-only account status for the signed-in user's personal Eliza.
 *
 * Identity resolution is independent of chat history and inference so login
 * can always bind the rowless Shared service without creating paid compute.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { personalSharedAgent } from "@/lib/services/shared-runtime/personal-shared-agent";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agent = personalSharedAgent({
      userId: user.id,
      organizationId: user.organization_id,
    });
    return c.json({
      success: true,
      data: {
        identity: {
          id: agent.id,
          displayName: agent.agent_name ?? "Eliza",
          runtime: "shared" as const,
        },
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
