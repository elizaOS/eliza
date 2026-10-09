// Handles webhook cloud API eliza app webhook discord route traffic with signature or internal auth checks.

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { forwardToDiscordWebhookHandler } from "../_forward";

const app = new Hono<AppEnv>();
app.all("/", (c) => forwardToDiscordWebhookHandler(c));
app.all("/*", (c) => forwardToDiscordWebhookHandler(c));
export default app;
