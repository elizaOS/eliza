/** Serves merchant refund review through current app-owner authorization. */
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  appBillingAdminHandlers,
  appBillingAdministrationBoundary,
} from "../_handlers";

const app = new Hono<AppEnv>();
appBillingAdministrationBoundary(app);
app.get("/", appBillingAdminHandlers.paidPeriods);
export default app;
