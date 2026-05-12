/**
 * POST /api/v1/eliza/plaid/exchange
 *
 * Exchanges a Plaid Link `public_token` for a long-lived `access_token`
 * and returns institution + account metadata.
 *
 * The caller (Agent runtime) should persist the `accessToken` securely
 * server-side and key it to the local payment_source row. Never return the
 * raw `accessToken` to a browser client.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentPlaidConnectorError,
  exchangePlaidPublicToken,
  getPlaidItemInfo,
} from "@/lib/services/agent-plaid-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const requestSchema = z.object({
  publicToken: z.string().trim().min(1),
});

app.post("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "publicToken is required.", details: parsed.error.issues }, 400);
    }
    const exchange = await exchangePlaidPublicToken({ publicToken: parsed.data.publicToken });
    const info = await getPlaidItemInfo({ accessToken: exchange.accessToken });
    return c.json({
      accessToken: exchange.accessToken,
      itemId: exchange.itemId,
      institution: info,
    });
  } catch (error) {
    if (error instanceof AgentPlaidConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
