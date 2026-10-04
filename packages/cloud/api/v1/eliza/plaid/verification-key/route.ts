/**
 * Returns an authenticated Plaid JWK for local verification of a signed
 * webhook delivery; expired upstream keys are rejected before this boundary.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  AgentPlaidConnectorError,
  getPlaidWebhookVerificationKey,
} from "@elizaos/cloud-shared/lib/services/agent-plaid-connector";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

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
