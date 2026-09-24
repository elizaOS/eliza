/** Lets the current app owner manage a registered confidential client. */
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  appClientManagementBoundary,
  rotateAppDelegationClient,
} from "../../_handlers";

const app = new Hono<AppEnv>();
appClientManagementBoundary(app);
app.post("/", rotateAppDelegationClient);
export default app;
