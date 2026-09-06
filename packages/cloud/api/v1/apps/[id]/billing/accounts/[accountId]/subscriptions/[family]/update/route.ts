/** Mounts a generic app subscription update operation. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  billingRoute,
  updateBillingSubscription,
} from "../../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", updateBillingSubscription);
export default app;
