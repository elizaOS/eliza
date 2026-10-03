/** Accepts merchant refunds through current owner-session and durable billing authority. */
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  appBillingAdminHandlers,
  appBillingAdministrationBoundary,
} from "../_handlers";

const app = new Hono<AppEnv>();
appBillingAdministrationBoundary(app);
app.post("/", appBillingAdminHandlers.refund);
export default app;
