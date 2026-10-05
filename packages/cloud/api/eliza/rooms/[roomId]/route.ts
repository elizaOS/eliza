/**
 * /api/eliza/rooms/:roomId — agent room details + messages.
 *
 * Workers sidecar boundary: depends on the elizaOS agent runtime and `@elizaos/core`
 * (Memory type, agentsService). Agent runtime lives on the Node sidecar
 * (`services/agent-server`); the sidecar serves this URL. See
 * cloud/INFRA.md "Long-running services NOT migrated".
 */

import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();
app.all("/", (c) =>
  c.json(
    {
      success: false,
      error: "Unsupported on Workers (agent-server sidecar handles this)",
    },
    501,
  ),
);

export default app;
