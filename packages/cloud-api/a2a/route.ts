/**
 * /api/a2a — Agent-to-Agent JSON-RPC endpoint (A2A spec v0.3.0).
 *
 * Platform A2A endpoint for Cloud operations. Per-agent runtime A2A remains
 * under /api/agents/:id/a2a; this route exposes account, credits, billing,
 * containers, apps, MCP, A2A, and admin capability contracts.
 */

import { Hono } from "hono";
import { getPlatformAgentCard, handlePlatformA2aJsonRpc } from "@/lib/api/a2a/platform-cloud";
import { A2AErrorCodes, jsonRpcError } from "@/lib/types/a2a";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", (c) =>
  c.json(getPlatformAgentCard(c), 200, {
    "Cache-Control": "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
  }),
);

app.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(jsonRpcError(A2AErrorCodes.PARSE_ERROR, "Parse error", null), 400);
  }

  const messages = Array.isArray(body) ? body : [body];
  const results = await Promise.all(
    messages.map((message) =>
      handlePlatformA2aJsonRpc(
        c,
        message as {
          id?: string | number | null;
          method?: string;
          params?: Record<string, unknown>;
        },
      ),
    ),
  );

  return c.json(Array.isArray(body) ? results : results[0]);
});

export default app;
