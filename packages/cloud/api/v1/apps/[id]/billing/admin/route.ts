/** Serves app-owner overview through the generic billing administration boundary. */
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  appBillingAdminHandlers,
  appBillingAdministrationBoundary,
} from "./_handlers";

const app = new Hono<AppEnv>();
appBillingAdministrationBoundary(app);
app.get("/", appBillingAdminHandlers.overview);
export default app;
