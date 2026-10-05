/** Mounts a generic app subscription update operation. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import {
  billingRoute,
  updateBillingSubscription,
} from "../../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", updateBillingSubscription);
export default app;
