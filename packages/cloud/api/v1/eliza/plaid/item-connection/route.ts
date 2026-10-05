/**
 * Resolves the Item id from a verified Plaid webhook to the caller's opaque
 * organization-scoped connection id without contacting Plaid.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  PlaidConnectionError,
  plaidConnectionService,
} from "@elizaos/cloud-shared/lib/services/plaid-connections";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono<AppEnv>();
const requestSchema = z.object({ itemId: z.string().trim().min(1) }).strict();

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
        { error: "itemId is required.", details: parsed.error.issues },
        400,
      );
    }
    return c.json(
      await plaidConnectionService.resolveItem({
        organizationId: user.organization_id,
        itemId: parsed.data.itemId,
      }),
    );
  } catch (error) {
    if (error instanceof PlaidConnectionError) {
      return c.json({ error: error.message }, error.status);
    }
    return failureResponse(c, error);
  }
});

export default app;
