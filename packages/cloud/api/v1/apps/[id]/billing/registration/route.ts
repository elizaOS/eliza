/** Creates an unconfigured app billing registration from authenticated app-owner provenance; accepts no provider identities. */
import { Hono } from "hono";
import { z } from "zod";
import { appBillingAccountsRepository } from "@/db/repositories/app-billing-accounts";
import { checkCookieMutationGuard } from "@/lib/auth/cookie-mutation-guard";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  appBillingEnvironment,
  appBillingFailure,
  appBillingId,
  appBillingPrincipal,
} from "../_boundary";

const inputSchema = z.object({ environment: appBillingEnvironment }).strict();
const app = new Hono<AppEnv>();
app.post("/", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const guard = checkCookieMutationGuard(
      c.req,
      c.env?.ENVIRONMENT,
      c.env?.NODE_ENV === "production",
    );
    if (!guard.ok)
      return c.json(
        { success: false, code: guard.code, error: "Forbidden" },
        403,
      );
    const appId = appBillingId.parse(c.req.param("id"));
    const principal = await appBillingPrincipal(c, appId, true);
    const decoded = await decodeRequestJson(c.req);
    if (!decoded.ok) {
      // error-policy:J3 Malformed JSON is rejected before registration.
      return c.json(
        {
          success: false,
          code: "validation_error",
          error: "Invalid JSON body",
        },
        400,
      );
    }
    const input = inputSchema.parse(decoded.value);
    return c.json({
      success: true as const,
      data: await appBillingAccountsRepository.register(
        appId,
        input.environment,
        principal,
      ),
    });
  } catch (error) {
    // error-policy:J1 The HTTP boundary translates auth, validation and unavailable authority failures.
    return appBillingFailure(c, error);
  }
});
export default app;
