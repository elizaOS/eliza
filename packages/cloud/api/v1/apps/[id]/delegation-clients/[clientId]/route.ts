/** Lets the current app owner revoke a registered confidential client. */
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  appClientManagementBoundary,
  revokeAppDelegationClient,
} from "../_handlers";

const app = new Hono<AppEnv>();
appClientManagementBoundary(app);
app.delete("/", revokeAppDelegationClient);
export default app;
