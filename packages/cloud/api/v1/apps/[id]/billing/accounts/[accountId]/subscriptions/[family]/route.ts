/** Mounts the canonical generic app billing accounts/[accountId]/subscriptions/[family] endpoint. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { billingRoute, getBillingSnapshot } from "../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.get("/", getBillingSnapshot);
export default app;
