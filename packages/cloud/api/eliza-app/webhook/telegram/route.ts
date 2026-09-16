// Handles webhook cloud API eliza app webhook telegram route traffic with signature or internal auth checks.
import { Hono } from "hono";
import { isPersonalSharedTelegramEdgeEnabled } from "@/api-app/personal-shared-telegram-edge";
import type { AppEnv } from "@/types/cloud-worker-env";
import { forwardToWebhookGateway, safeWebhookSuffix } from "../_forward";
import {
  handlePersonalTelegramDeliveryLedger,
  handlePersonalTelegramEdge,
  handlePersonalTelegramIdentityReadiness,
  personalTelegramGatewayConnectorAccountFailure,
  personalTelegramIdentityFailure,
  verifyPersonalTelegramGatewayRequest,
} from "../_telegram-edge";

const app = new Hono<AppEnv>();
const handle = async (c: Parameters<typeof handlePersonalTelegramEdge>[0]) => {
  const suffix = safeWebhookSuffix(new URL(c.req.url).pathname, "telegram");
  if (c.req.method === "GET" && suffix === "/readiness") {
    return handlePersonalTelegramIdentityReadiness(c);
  }
  if (c.req.method === "POST" && suffix === "/delivery") {
    if (!verifyPersonalTelegramGatewayRequest(c)) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    const identityFailure = await personalTelegramIdentityFailure(c);
    return identityFailure ?? handlePersonalTelegramDeliveryLedger(c);
  }
  if (c.req.method === "POST" && suffix === "/edge") {
    if (!verifyPersonalTelegramGatewayRequest(c)) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    const connectorAccountFailure =
      await personalTelegramGatewayConnectorAccountFailure(c);
    return connectorAccountFailure ?? handlePersonalTelegramEdge(c);
  }
  return c.req.method === "POST" &&
    isPersonalSharedTelegramEdgeEnabled(c.env) &&
    suffix === ""
    ? handlePersonalTelegramEdge(c)
    : forwardToWebhookGateway(c, "telegram");
};
app.all("/", handle);
app.all("/*", handle);
export default app;
