/**
 * POST /api/eliza-app/gateway/:agentId
 *
 * Demo gateway that echoes a canned reply per agentId. Note: the in-memory
 * `agentMemories` map will not persist across Workers isolates — restored
 * here as-is to preserve the response shape, but the "history" effectively
 * resets per request on Workers.
 */

import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

const agentMemories = new Map<string, Array<{ role: string; content: string }>>();

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const agentId = c.req.param("agentId") ?? "";
    const body = (await c.req.json()) as { message?: string };
    const message = body?.message;

    if (!message) {
      return c.json({ success: false, error: "Empty message" }, 400);
    }

    if (!agentMemories.has(agentId)) agentMemories.set(agentId, []);
    const history = agentMemories.get(agentId)!;
    history.push({ role: "user", content: message });

    const lowerMessage = message.toLowerCase();
    let reply = "";
    if (lowerMessage.includes("hello") || lowerMessage.includes("hi")) {
      reply = `Hello there! I'm your dedicated agent (${agentId}). How can I help you today?`;
    } else if (lowerMessage.includes("status") || lowerMessage.includes("mode")) {
      reply = `I am operating normally. If I were a workflow agent, I'd run the workflow here. If I were autonomous, I'd spawn an isolated container.`;
    } else {
      reply = `I received your message: "${message}". I will process it based on my configured capabilities.`;
    }
    history.push({ role: "assistant", content: reply });

    await new Promise((resolve) => setTimeout(resolve, 800));

    return c.json({ success: true, reply, historyLength: history.length });
  } catch (e) {
    return c.json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export default app;
