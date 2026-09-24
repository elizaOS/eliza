/** Mounts a generic app subscription checkout operation. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { billingRoute, createBillingCheckout } from "../../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", createBillingCheckout);
export default app;
