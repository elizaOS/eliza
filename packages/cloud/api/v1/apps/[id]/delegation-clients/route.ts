/** Lets the current app owner manage a registered confidential client. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import {
  appClientManagementBoundary,
  listAppDelegationClients,
  registerAppDelegationClient,
} from "./_handlers";

const app = new Hono<AppEnv>();
appClientManagementBoundary(app);
app.get("/", listAppDelegationClients);
app.post("/", registerAppDelegationClient);
export default app;
