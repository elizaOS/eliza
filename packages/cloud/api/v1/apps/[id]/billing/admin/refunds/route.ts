/** Accepts merchant refunds through current owner-session and durable billing authority. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import {
  appBillingAdminHandlers,
  appBillingAdministrationBoundary,
} from "../_handlers";

const app = new Hono<AppEnv>();
appBillingAdministrationBoundary(app);
app.post("/", appBillingAdminHandlers.refund);
export default app;
