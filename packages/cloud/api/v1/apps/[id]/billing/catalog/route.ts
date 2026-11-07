/** Mounts the canonical generic app billing catalog endpoint. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { billingRoute, getBillingCatalog } from "../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.get("/", getBillingCatalog);
export default app;
