/**
 * POST /api/eliza/rooms/:roomId/messages/stream — stubbed.
 *
 * Streaming variant of /messages: same elizaOS runtime blocker. Per the
 * realtime audit this route is `runtime: "nodejs"`-pinned regardless.
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.all("/*", (c) =>
  c.json({ error: "not_yet_migrated", reason: "elizaOS runtime is not Workers-compatible" }, 501),
);
export default app;
