/**
 * Eliza-app webhook — stubbed.
 *
 * Spawns an elizaOS runtime via @/lib/eliza/runtime-factory or
 * message-handler. Both load @elizaos/core + downstream plugins
 * (Node-only blocker per AGENTS.md).
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.all("/*", (c) =>
  c.json({ error: "not_yet_migrated", reason: "elizaOS runtime is not Workers-compatible" }, 501),
);
export default app;
