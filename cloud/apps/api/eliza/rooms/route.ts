/**
 * /api/eliza/rooms — agent room CRUD.
 *
 * Workers stub: depends on the elizaOS agent runtime
 * (`packages/lib/services/agents/agents.ts` → `@elizaos/core`). Agent runtime
 * lives on the Node sidecar (`services/agent-server`); the sidecar serves
 * this URL. See cloud/INFRA.md "Long-running services NOT migrated".
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
