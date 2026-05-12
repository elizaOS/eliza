/**
 * POST /api/eliza-app/provision-agent
 *
 * Demo provisioning endpoint that mints an agentId based on `mode`. The
 * in-memory `agentsStore` map will not persist across Workers isolates;
 * preserved as-is to keep the response shape identical.
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const agentsStore = new Map();

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as { userId?: string; name?: string; mode?: string };
    const { userId, name, mode } = body;

    if (!userId || !mode) {
      return c.json({ success: false, error: "Missing required fields" }, 400);
    }

    const agentId = "agent-" + Math.random().toString(36).substring(2, 10);
    agentsStore.set(agentId, {
      ownerId: userId,
      name: name || "Unknown",
      mode,
      createdAt: Date.now(),
      status: "provisioned",
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    let message = "";
    if (mode === "Chat") {
      message = "Allocated shared cloud-hosted base agent.";
    } else if (mode === "Workflow") {
      message = "Allocated cloud-hosted agent + workflow plugin connected.";
    } else if (mode === "Autonomous") {
      message = "Provisioned dedicated sandbox for autonomous execution.";
    }

    const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    return c.json({
      success: true,
      agentId,
      message,
      gatewayUrl: `${baseUrl}/api/eliza-app/gateway/${agentId}`,
    });
  } catch (e) {
    return c.json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export default app;
