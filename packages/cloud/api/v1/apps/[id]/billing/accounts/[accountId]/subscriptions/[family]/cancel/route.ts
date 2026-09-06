/** Mounts a generic app subscription cancel operation. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  billingRoute,
  cancelBillingSubscription,
} from "../../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", cancelBillingSubscription);
export default app;
