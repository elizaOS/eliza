import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { forwardToWebhookGateway } from "../_forward";

const app = new Hono<AppEnv>();
app.all("/", (c) => forwardToWebhookGateway(c, "whatsapp"));
app.all("/*", (c) => forwardToWebhookGateway(c, "whatsapp"));
export default app;
