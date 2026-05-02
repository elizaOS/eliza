/**
 * POST /api/eliza/rooms/:roomId/messages — stubbed.
 *
 * Spawns an elizaOS runtime via `@/lib/eliza/runtime-factory` /
 * `message-handler`. Both load `@elizaos/core` + downstream plugin runtime,
 * which is the canonical Node-only blocker per AGENTS.md / SOURCE_NOTES.
 *
 * Re-enables when the elizaOS runtime is hosted in a Node sidecar (or when
 * the runtime ships a Workers build).
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.all("/*", (c) =>
  c.json({ error: "not_yet_migrated", reason: "elizaOS runtime is not Workers-compatible" }, 501),
);
export default app;
