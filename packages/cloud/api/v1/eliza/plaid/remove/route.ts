/**
 * POST /api/v1/eliza/plaid/remove
 *
 * Disconnects a Plaid Item (`/item/remove`). Idempotent: an Item that was
 * already removed reports `alreadyRemoved: true` instead of failing, so the
 * Agent runtime's disconnect cleanup can be retried safely.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentPlaidConnectorError,
  removePlaidItem,
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
    const result = await removePlaidItem(parsed.data);
    return c.json(result);
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
