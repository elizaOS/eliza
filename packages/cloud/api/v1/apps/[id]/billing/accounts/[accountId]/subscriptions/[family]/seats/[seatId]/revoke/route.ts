/** Mounts authorized app subscription revoke records. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { billingRoute } from "../../../../../../../_handlers";
import { revokeBillingSeat } from "../../../../../../../_records-handlers";

const app: Hono<AppEnv> = billingRoute();
app.post("/", revokeBillingSeat);
export default app;
