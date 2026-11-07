/** Serves the registered app googleConnections operation through the shared consent boundary. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { appDelegationBoundary, appDelegationHandlers } from "../../_handlers";

const app = new Hono<AppEnv>();
appDelegationBoundary(app);
app.get("/", appDelegationHandlers.googleConnections);
export default app;
