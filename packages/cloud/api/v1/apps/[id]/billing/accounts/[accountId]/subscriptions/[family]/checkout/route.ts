/** Mounts a generic app subscription checkout operation. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { billingRoute, createBillingCheckout } from "../../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", createBillingCheckout);
export default app;
