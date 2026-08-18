/**
 * Revokes a Plaid Item and deletes its organization-bound Cloud credential.
 * Repeated requests are idempotent and never disclose whether another tenant
 * owns the supplied connection id.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { AgentPlaidConnectorError } from "@/lib/services/agent-plaid-connector";
import {
  PlaidConnectionError,
  plaidConnectionService,
} from "@/lib/services/plaid-connections";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const requestSchema = z
  .object({
    connectionId: z.string().uuid(),
  })
  .strict();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = requestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        { error: "connectionId is required.", details: parsed.error.issues },
        400,
      );
    }
    return c.json(
      await plaidConnectionService.revoke({
        organizationId: user.organization_id,
        connectionId: parsed.data.connectionId,
      }),
    );
  } catch (error) {
    if (error instanceof PlaidConnectionError) {
      return c.json({ error: error.message }, error.status);
    }
    if (error instanceof AgentPlaidConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
