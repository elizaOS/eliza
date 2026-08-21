/**
 * Returns an authenticated Plaid JWK for local verification of a signed
 * webhook delivery; expired upstream keys are rejected before this boundary.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentPlaidConnectorError,
  getPlaidWebhookVerificationKey,
} from "@/lib/services/agent-plaid-connector";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
const requestSchema = z.object({ keyId: z.string().trim().min(1) }).strict();

app.post("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    const decoded = await decodeRequestJson(c.req);
    if (!decoded.ok) {
      // error-policy:J3 malformed JSON is explicit invalid request input.
      return c.json({ error: "Invalid JSON body." }, 400);
    }
    const parsed = requestSchema.safeParse(decoded.value);
    if (!parsed.success) {
      return c.json(
        { error: "keyId is required.", details: parsed.error.issues },
        400,
      );
    }
    return c.json(await getPlaidWebhookVerificationKey(parsed.data));
  } catch (error) {
    if (error instanceof AgentPlaidConnectorError) {
      return c.json(
        { error: error.message, code: error.code },
        error.status as 400,
      );
    }
    return failureResponse(c, error);
  }
});

export default app;
