// Handles webhook cloud API eliza app webhook twilio route traffic with signature or internal auth checks.

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { forwardToWebhookGateway } from "../_forward";

const app = new Hono<AppEnv>();
app.all("/", (c) => forwardToWebhookGateway(c, "twilio"));
app.all("/*", (c) => forwardToWebhookGateway(c, "twilio"));
export default app;
