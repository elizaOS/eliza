/** Mounts a generic app subscription portal operation. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { billingRoute, createBillingPortal } from "../../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", createBillingPortal);
export default app;
