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
import { AgentPlaidConnectorError } from "@/lib/services/agent-plaid-connector";
import {
  PlaidConnectionError,
  plaidConnectionService,
} from "@/lib/services/plaid-connections";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const requestSchema = z.object({ connectionId: z.string().uuid() }).strict();

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
        { error: "connectionId is required.", details: parsed.error.issues },
        400,
      );
    }
    const status = await plaidConnectionService.status({
      organizationId: user.organization_id,
      connectionId: parsed.data.connectionId,
    });
    return c.json(status);
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
