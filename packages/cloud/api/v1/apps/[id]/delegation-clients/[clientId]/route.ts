/** Lets the current app owner revoke a registered confidential client. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import {
  appClientManagementBoundary,
  revokeAppDelegationClient,
} from "../_handlers";

const app = new Hono<AppEnv>();
appClientManagementBoundary(app);
app.delete("/", revokeAppDelegationClient);
export default app;
