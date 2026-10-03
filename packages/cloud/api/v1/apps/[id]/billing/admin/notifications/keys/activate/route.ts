/** Exposes authenticated developer notification configuration through the generic app API. */
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { activateNotificationKey, notificationBoundary } from "../../_handlers";

const app = new Hono<AppEnv>();
notificationBoundary(app);
app.post("/", activateNotificationKey);
export default app;
