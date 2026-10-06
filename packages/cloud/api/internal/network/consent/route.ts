/** Records The Network's STOP/START keywords in the durable Postgres consent ledger. */

import { Hono } from "hono";
import { jsonError } from "@/lib/api/cloud-worker-errors";
import {
  networkConsentEntrySchema,
  networkConsentWriter,
} from "@/lib/network/consent";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../_auth";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  const auth = await requireInternalAuth(c);
  if (auth instanceof Response) return auth;
  if (auth.service !== "webhook-gateway" && auth.service !== "shared-secret") {
    return jsonError(c, 403, "Forbidden", "access_denied");
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    // error-policy:J3 malformed internal input is explicitly invalid.
    return jsonError(c, 400, "Invalid consent entry", "validation_error");
  }
  const parsed = networkConsentEntrySchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(c, 400, "Invalid consent entry", "validation_error");
  }
  const { recorded } = await networkConsentWriter.append(parsed.data);
  return c.json({ success: true, data: { recorded } });
});

export default app;
