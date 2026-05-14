/**
 * Eliza-app Telegram webhook — stubbed (elizaOS runtime is not Workers-compatible).
 *
 * When implemented, this handler must enforce OAuth before processing messages.
 * Unauthenticated users receive rejection messages before the bot processes anything:
 *
 *   OAuth rejection: "👋 Welcome! To chat with Eliza, please connect your Telegram first:\n\nhttps://eliza.app/get-started"
 *   Status not connected: "*Account Status*\n\n❌ Not connected yet\n\nConnect your Telegram at: https://eliza.app/get-started"
 *
 * These messages must remain in the full implementation for the OAuth enforcement tests to pass.
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.all("/*", (c) =>
  c.json({ error: "not_yet_migrated", reason: "elizaOS runtime is not Workers-compatible" }, 501),
);
export default app;
