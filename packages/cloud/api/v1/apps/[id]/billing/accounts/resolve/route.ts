/** Mounts the canonical generic app billing accounts/resolve endpoint. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { billingRoute, resolveBillingAccount } from "../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", resolveBillingAccount);
export default app;
