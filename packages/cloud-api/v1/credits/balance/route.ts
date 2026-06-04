/**
 * GET /api/v1/credits/balance — credit balance for the user's org.
 * Query: fresh=true bypasses cached session and fetches from DB.
 *
 * CORS is handled globally (wildcard origin, no credentials).
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead } from "@/db/helpers";
import { agentSandboxes } from "@/db/schemas/agent-sandboxes";
import {
  failureResponse,
  ValidationError,
} from "@/lib/api/cloud-worker-errors";
import { validateServiceKey } from "@/lib/auth/service-key-hono-worker";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getCreditBalanceResponse } from "@/lib/services/credit-balance-response";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const organizationId = await resolveCreditOrganizationId(
      c,
      c.req.query("agent_id"),
    );
    const body = await getCreditBalanceResponse(organizationId);

    c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    return c.json(body);
  } catch (error) {
    return failureResponse(c, error);
  }
});

async function resolveCreditOrganizationId(
  c: Parameters<typeof requireUserOrApiKeyWithOrg>[0],
  agentId?: string,
): Promise<string> {
  if (!agentId) {
    const user = await requireUserOrApiKeyWithOrg(c);
    return user.organization_id;
  }
  await validateServiceKey(c);

  const [sandbox] = await dbRead
    .select({ organizationId: agentSandboxes.organization_id })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId))
    .limit(1);
  if (!sandbox) throw ValidationError("Invalid agent_id");
  return sandbox.organizationId;
}

export default app;
