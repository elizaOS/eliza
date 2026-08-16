// Handles webhook cloud API eliza app webhook telegram route traffic with signature or internal auth checks.
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { forwardToWebhookGateway, safeWebhookSuffix } from "../_forward";
import { handlePersonalTelegramEdge } from "../_telegram-edge";

const app = new Hono<AppEnv>();
const handle = (c: Parameters<typeof handlePersonalTelegramEdge>[0]) =>
  c.req.method === "POST" &&
  c.env.PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED === "true" &&
  safeWebhookSuffix(new URL(c.req.url).pathname, "telegram") === ""
    ? handlePersonalTelegramEdge(c)
    : forwardToWebhookGateway(c, "telegram");
app.all("/", handle);
app.all("/*", handle);
export default app;
