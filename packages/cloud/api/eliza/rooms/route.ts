/**
 * /api/eliza/rooms — agent room CRUD.
 *
 * Workers sidecar boundary: depends on the elizaOS agent runtime
 * (`packages/lib/services/agents/agents.ts` → `@elizaos/core`). Agent runtime
 * lives on the Node sidecar (`services/agent-server`); the sidecar serves
 * this URL. See cloud/INFRA.md "Long-running services NOT migrated".
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
