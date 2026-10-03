/** Mounts the canonical generic app billing accounts/[accountId]/subscriptions/[family] endpoint. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { billingRoute, getBillingSnapshot } from "../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.get("/", getBillingSnapshot);
export default app;
