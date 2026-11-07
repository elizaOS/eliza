/** Mounts a generic app subscription quote operation. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { billingRoute, quoteBillingUpdate } from "../../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", quoteBillingUpdate);
export default app;
