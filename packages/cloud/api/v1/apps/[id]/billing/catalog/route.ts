/** Mounts the canonical generic app billing catalog endpoint. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { billingRoute, getBillingCatalog } from "../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.get("/", getBillingCatalog);
export default app;
