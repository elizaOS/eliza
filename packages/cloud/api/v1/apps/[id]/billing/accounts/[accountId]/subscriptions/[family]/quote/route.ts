/** Mounts a generic app subscription quote operation. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { billingRoute, quoteBillingUpdate } from "../../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", quoteBillingUpdate);
export default app;
