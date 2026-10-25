/**
 * POST /api/v1/eliza/plaid/exchange
 *
 * Exchanges a Plaid Link `public_token`, stores the resulting Item credential
 * under the authenticated organization, and returns an opaque connection id.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { AgentPlaidConnectorError } from "@elizaos/cloud-shared/lib/services/agent-plaid-connector";
import {
  PlaidConnectionError,
  plaidConnectionService,
} from "@elizaos/cloud-shared/lib/services/plaid-connections";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono<AppEnv>();

const requestSchema = z
  .object({
    publicToken: z.string().trim().min(1),
  })
  .strict();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const decoded = await decodeRequestJson(c.req);
    if (!decoded.ok) {
      // error-policy:J3 malformed JSON is explicit invalid request input.
      return c.json({ error: "Invalid JSON body." }, 400);
    }
    const parsed = requestSchema.safeParse(decoded.value);
    if (!parsed.success) {
      return c.json(
        { error: "publicToken is required.", details: parsed.error.issues },
        400,
      );
    }
    const exchange = await plaidConnectionService.exchange({
      organizationId: user.organization_id,
      publicToken: parsed.data.publicToken,
    });
    return c.json(exchange);
  } catch (error) {
    if (error instanceof PlaidConnectionError) {
      return c.json({ error: error.message }, error.status);
    }
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
