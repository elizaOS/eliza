/** Reads an app billing operation under its current account membership. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { billingRoute, getBillingOperation } from "../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.get("/", getBillingOperation);
export default app;
