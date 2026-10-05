/** Mounts the canonical generic app billing accounts/resolve endpoint. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { billingRoute, resolveBillingAccount } from "../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", resolveBillingAccount);
export default app;
