/**
 * POST /api/v1/eliza/plaid/link-token
 *
 * Creates a Plaid Link token for the caller's organization. The Agent
 * runtime client uses this token to open the Plaid Link UI.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentPlaidConnectorError,
  createPlaidLinkToken,
} from "@/lib/services/agent-plaid-connector";
import {
  PlaidConnectionError,
  plaidConnectionService,
} from "@/lib/services/plaid-connections";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
const requestSchema = z
  .object({
    connectionId: z.string().uuid().optional(),
    webhookUrl: z.string().url().optional(),
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
    if (!parsed.success)
      return c.json({ error: "Invalid Plaid link request." }, 400);
    const result = parsed.data.connectionId
      ? await plaidConnectionService.createUpdateLinkToken({
          organizationId: user.organization_id,
          userId: user.id,
          connectionId: parsed.data.connectionId,
          webhookUrl: parsed.data.webhookUrl,
        })
      : await createPlaidLinkToken({
          organizationId: user.organization_id,
          userId: user.id,
          webhookUrl: parsed.data.webhookUrl,
        });
    return c.json(result);
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
