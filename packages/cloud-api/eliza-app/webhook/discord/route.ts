import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { forwardToDiscordWebhookHandler } from "../_forward";

const app = new Hono<AppEnv>();
app.all("/", (c) => forwardToDiscordWebhookHandler(c));
app.all("/*", (c) => forwardToDiscordWebhookHandler(c));
export default app;
