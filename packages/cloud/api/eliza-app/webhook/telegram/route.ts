// Handles webhook cloud API eliza app webhook telegram route traffic with signature or internal auth checks.
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { forwardToWebhookGateway, safeWebhookSuffix } from "../_forward";
import {
  handlePersonalTelegramDeliveryLedger,
  handlePersonalTelegramEdge,
  verifyPersonalTelegramGatewayRequest,
} from "../_telegram-edge";

const app = new Hono<AppEnv>();
const handle = async (c: Parameters<typeof handlePersonalTelegramEdge>[0]) => {
  const suffix = safeWebhookSuffix(new URL(c.req.url).pathname, "telegram");
  if (c.req.method === "POST" && suffix === "/delivery") {
    return handlePersonalTelegramDeliveryLedger(c);
  }
  if (c.req.method === "POST" && suffix === "/edge") {
    return verifyPersonalTelegramGatewayRequest(c)
      ? handlePersonalTelegramEdge(c)
      : c.json({ success: false, error: "Unauthorized" }, 401);
  }
  return c.req.method === "POST" &&
    c.env.PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED === "true" &&
    suffix === ""
    ? handlePersonalTelegramEdge(c)
    : forwardToWebhookGateway(c, "telegram");
};
app.all("/", handle);
app.all("/*", handle);
export default app;
