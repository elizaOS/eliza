/** Mounts a generic app subscription checkout/expire operation. */
import type { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  billingRoute,
  expireBillingCheckout,
} from "../../../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", expireBillingCheckout);
export default app;
