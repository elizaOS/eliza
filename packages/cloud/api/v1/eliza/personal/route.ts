/**
 * Account status and chat destination for the signed-in user's personal Eliza.
 *
 * Identity resolution is independent of inference so login can always bind
 * the rowless Shared service without creating paid compute. With a cut-over
 * Dedicated it goes through the entitlement route authority (#25146): a
 * withdrawn Dedicated reports the Shared fallback with its typed account state
 * and pay action, and recovery reconciles the fallback interval into the same
 * Dedicated agent id before that id is handed back.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  personalDirectChatRefusalResponse,
  resolvePersonalDirectChatRoute,
} from "@elizaos/cloud-shared/lib/services/personal-direct-chat-route";
import {
  personalDedicatedClientApiBase,
  personalSharedAgent,
} from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-agent";
import { resolveSharedRuntimeWorkerRequestContext } from "@elizaos/cloud-shared/lib/services/shared-runtime/resolve-shared-agent";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const agent = personalSharedAgent({
      userId: user.id,
      organizationId: user.organization_id,
    });
    // The conversation coordinator is needed only to reconcile a recovered
    // interval; plain identity resolution never depends on it.
    const worker = resolveSharedRuntimeWorkerRequestContext(c);
    const route = await resolvePersonalDirectChatRoute({
      organizationId: user.organization_id,
      userId: user.id,
      sourceAgentId: agent.id,
      namespace: "error" in worker ? undefined : worker.namespace,
    });
    if (route.route === "refused") {
      const refusal = personalDirectChatRefusalResponse(route);
      return c.json(refusal.body, refusal.status, refusal.headers);
    }
    const dedicatedApiBase =
      route.route === "dedicated"
        ? personalDedicatedClientApiBase(
            route.dedicated,
            c.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
            new URL(c.req.url).origin,
          )
        : null;
    return c.json({
      success: true,
      data: {
        identity:
          route.route === "dedicated" && dedicatedApiBase
            ? {
                id: agent.id,
                displayName:
                  route.dedicated.agent_name ?? agent.agent_name ?? "Eliza",
                runtime: "dedicated" as const,
                activeAgentId: route.dedicated.id,
                apiBase: dedicatedApiBase,
              }
            : {
                id: agent.id,
                displayName: agent.agent_name ?? "Eliza",
                runtime: "shared" as const,
                // Present only while Dedicated access is withdrawn. The app
                // keeps the canonical conversation id; the Shared surfaces
                // serve it from the scoped fallback journal.
                ...(route.route === "shared_fallback"
                  ? { accountState: route.accountState }
                  : {}),
              },
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
