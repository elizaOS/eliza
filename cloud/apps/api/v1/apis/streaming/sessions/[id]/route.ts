/**
 * GET    /api/v1/apis/streaming/sessions/:id
 * DELETE /api/v1/apis/streaming/sessions/:id
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    const sessionId = c.req.param("id");
    return c.json({
      sessionId,
      status: "stub",
      bytesIn: 0,
      destinationsHealth: {} as Record<string, "ok" | "failing" | "closed">,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    const sessionId = c.req.param("id");
    if (!sessionId || sessionId.length === 0) {
      return c.json({ error: "Missing session id" }, 400);
    }
    return c.body(null, 204);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
