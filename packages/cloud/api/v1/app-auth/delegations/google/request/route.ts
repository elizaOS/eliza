/** Serves the registered app googleRequest operation through the shared consent boundary. */
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { appDelegationBoundary, appDelegationHandlers } from "../../_handlers";

const app = new Hono<AppEnv>();
appDelegationBoundary(app);
app.post("/", appDelegationHandlers.googleRequest);
export default app;
