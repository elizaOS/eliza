import type { Hono } from "hono";
import { Hono as HonoApp } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { handleBlueBubblesWebhook } from "../../../bluebubbles/route";

const app = new HonoApp<AppEnv>();
app.post("/", (c) => handleBlueBubblesWebhook(c));
app.get("/", (c) =>
  c.json({ status: "ok", service: "bluebubbles-blooio-bridge" }),
);

export default app satisfies Hono<AppEnv>;
