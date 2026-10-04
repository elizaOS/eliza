/** Mounts a generic app subscription checkout/expire operation. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import {
  billingRoute,
  expireBillingCheckout,
} from "../../../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", expireBillingCheckout);
export default app;
