/** Exposes authenticated developer notification configuration through the generic app API. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { notificationBoundary, prepareNotificationKey } from "../../_handlers";

const app = new Hono<AppEnv>();
notificationBoundary(app);
app.post("/", prepareNotificationKey);
export default app;
