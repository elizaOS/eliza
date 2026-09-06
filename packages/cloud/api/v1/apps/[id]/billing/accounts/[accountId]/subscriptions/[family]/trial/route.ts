/** Mounts a generic app subscription trial operation. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { billingRoute, startBillingTrial } from "../../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", startBillingTrial);
export default app;
