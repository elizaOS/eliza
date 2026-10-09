/** Mounts a generic app subscription cancel operation. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import {
  billingRoute,
  cancelBillingSubscription,
} from "../../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", cancelBillingSubscription);
export default app;
