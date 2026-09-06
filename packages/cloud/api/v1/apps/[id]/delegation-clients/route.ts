/** Lets the current app owner manage a registered confidential client. */
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
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
