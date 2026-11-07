/** Serves app-owner publishPlan through the generic billing administration boundary. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import {
  appBillingAdminHandlers,
  appBillingAdministrationBoundary,
} from "../../_handlers";

const app = new Hono<AppEnv>();
appBillingAdministrationBoundary(app);
app.post("/", appBillingAdminHandlers.publishPlan);
export default app;
