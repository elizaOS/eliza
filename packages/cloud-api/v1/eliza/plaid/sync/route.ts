/**
 * POST /api/v1/eliza/plaid/sync
 *
 * Forwards /transactions/sync to Plaid and returns the delta. The Agent
 * runtime caller should persist `nextCursor` per source so the next sync is
 * incremental.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentPlaidConnectorError,
  syncPlaidTransactions,
} from "@/lib/services/agent-plaid-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const requestSchema = z.object({
  accessToken: z.string().trim().min(1),
  cursor: z.string().optional(),
  count: z.number().int().min(1).max(500).optional(),
});

app.post("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid sync request.", details: parsed.error.issues }, 400);
    }
    const delta = await syncPlaidTransactions(parsed.data);
    return c.json(delta);
  } catch (error) {
    if (error instanceof AgentPlaidConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
