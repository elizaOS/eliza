/** Serves the registered app revoke operation through the shared consent boundary. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { appDelegationBoundary, appDelegationHandlers } from "../_handlers";

const app = new Hono<AppEnv>();
appDelegationBoundary(app);
app.post("/", appDelegationHandlers.revoke);
export default app;
