/**
 * POST /api/v1/eliza/plaid/webhook-key
 *
 * Returns the JWK for a Plaid webhook-verification key id so the Agent
 * runtime can verify the ES256 `Plaid-Verification` JWT on webhooks it
 * receives directly. Only the key *lookup* requires the Plaid client
 * credentials held by this deployment; the signature check happens at the
 * webhook receiver.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentPlaidConnectorError,
  getPlaidWebhookVerificationKey,
} from "@/lib/services/agent-plaid-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const requestSchema = z.object({
  keyId: z.string().trim().min(1),
});

app.post("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    const parsed = requestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        { error: "keyId is required.", details: parsed.error.issues },
        400,
      );
    }
    const result = await getPlaidWebhookVerificationKey(parsed.data);
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
