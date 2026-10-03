/** Serves app-owner onboardMerchant through the generic billing administration boundary. */
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  appBillingAdminHandlers,
  appBillingAdministrationBoundary,
} from "../../_handlers";

const app = new Hono<AppEnv>();
appBillingAdministrationBoundary(app);
app.post("/", appBillingAdminHandlers.onboardMerchant);
export default app;
