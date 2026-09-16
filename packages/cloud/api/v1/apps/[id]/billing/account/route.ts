/** Reads the caller's consent-bound individual account from primary storage without granting subscription or infrastructure rights. */
import { Hono } from "hono";
import { appBillingAccountsRepository } from "@/db/repositories/app-billing-accounts";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  appBillingEnvironment,
  appBillingFailure,
  appBillingId,
  appBillingPrincipal,
} from "../_boundary";

const app = new Hono<AppEnv>();
app.get("/", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const appId = appBillingId.parse(c.req.param("id"));
    const environment = appBillingEnvironment.parse(c.req.query("environment"));
    const principal = await appBillingPrincipal(c, appId, false);
    return c.json({
      success: true as const,
      data: await appBillingAccountsRepository.read(
        appId,
        environment,
        principal,
      ),
    });
  } catch (error) {
    // error-policy:J1 The HTTP boundary translates auth, validation and unavailable authority failures.
    return appBillingFailure(c, error);
  }
});
export default app;
