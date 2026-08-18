/**
 * POST /api/v1/eliza/plaid/sync
 *
 * Resolves an organization-scoped opaque connection id inside Cloud, forwards
 * /transactions/sync to Plaid, and returns the transaction delta.
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
    cursor: z.string().optional(),
    count: z.number().int().min(1).max(500).optional(),
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
        { error: "Invalid sync request.", details: parsed.error.issues },
        400,
      );
    }
    const delta = await plaidConnectionService.sync({
      organizationId: user.organization_id,
      ...parsed.data,
    });
    return c.json(delta);
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
