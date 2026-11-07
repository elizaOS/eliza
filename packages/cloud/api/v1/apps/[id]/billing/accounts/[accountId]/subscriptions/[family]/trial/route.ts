/** Mounts a generic app subscription trial operation. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { billingRoute, startBillingTrial } from "../../../../../_handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", startBillingTrial);
export default app;
