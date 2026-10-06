/** Exposes authenticated developer notification configuration through the generic app API. */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import {
  configureNotifications,
  notificationBoundary,
  readNotifications,
} from "./_handlers";

const app = new Hono<AppEnv>();
notificationBoundary(app);
app.get("/", readNotifications);
app.post("/", configureNotifications);
export default app;
