// Handles webhook cloud API eliza app webhook whatsapp route traffic with signature or internal auth checks.

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { forwardToWebhookGateway } from "../_forward";

const app = new Hono<AppEnv>();
app.all("/", (c) => forwardToWebhookGateway(c, "whatsapp"));
app.all("/*", (c) => forwardToWebhookGateway(c, "whatsapp"));
export default app;
