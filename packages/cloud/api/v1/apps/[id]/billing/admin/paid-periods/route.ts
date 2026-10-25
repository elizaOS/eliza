/** Serves merchant refund review through current app-owner authorization. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import {
  appBillingAdminHandlers,
  appBillingAdministrationBoundary,
} from "../_handlers";

const app = new Hono<AppEnv>();
appBillingAdministrationBoundary(app);
app.get("/", appBillingAdminHandlers.paidPeriods);
export default app;
