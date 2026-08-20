/**
 * POST /api/v1/eliza/plaid/item-status
 *
 * Reports an Item's health (pending error, consent expiry) so the Agent
 * runtime can mark a payment source needs_attention and drive update-mode
 * reauth before syncs start failing.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentPlaidConnectorError,
  getPlaidItemStatus,
} from "@/lib/services/agent-plaid-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const requestSchema = z.object({
  accessToken: z.string().trim().min(1),
});

app.post("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    const parsed = requestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        { error: "accessToken is required.", details: parsed.error.issues },
        400,
      );
    }
    const status = await getPlaidItemStatus(parsed.data);
    return c.json(status);
  } catch (error) {
    if (error instanceof AgentPlaidConnectorError) {
      return c.json(
        { error: error.message, errorCode: error.errorCode },
        error.status as 400,
      );
    }
    return failureResponse(c, error);
  }
});

export default app;
