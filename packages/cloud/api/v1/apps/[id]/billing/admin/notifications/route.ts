/** Exposes authenticated developer notification configuration through the generic app API. */
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
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
