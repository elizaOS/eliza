/**
 * /api/eliza/rooms/:roomId — agent room details + messages.
 *
 * Workers stub: depends on the elizaOS agent runtime and `@elizaos/core`
 * (Memory type, agentsService). Agent runtime lives on the Node sidecar
 * (`services/agent-server`); the sidecar serves this URL. See
 * cloud/INFRA.md "Long-running services NOT migrated".
 */

import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
app.all("/", (c) =>
  c.json(
    { success: false, error: "Not implemented on Workers (agent-server sidecar handles this)" },
    501,
  ),
);

export default app;
