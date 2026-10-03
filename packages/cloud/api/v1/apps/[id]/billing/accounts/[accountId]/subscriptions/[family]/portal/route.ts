/** Mounts a generic app subscription portal operation. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { billingRoute, createBillingPortal } from "../../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", createBillingPortal);
export default app;
