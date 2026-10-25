/** Reads an app billing operation under its current account membership. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { billingRoute, getBillingOperation } from "../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.get("/", getBillingOperation);
export default app;
