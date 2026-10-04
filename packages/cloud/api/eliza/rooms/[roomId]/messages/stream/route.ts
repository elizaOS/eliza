/**
 * POST /api/eliza/rooms/:roomId/messages/stream — sidecar-only.
 *
 * Streaming variant of /messages: same elizaOS runtime blocker. Per the
 * realtime audit this route is `runtime: "nodejs"`-pinned regardless.
 */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();
app.all("/*", (c) =>
  c.json(
    {
      error: "not_yet_migrated",
      reason: "elizaOS runtime is not Workers-compatible",
    },
    501,
  ),
);
export default app;
