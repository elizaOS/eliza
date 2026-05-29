import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import "./client-agent";
import type { AgentRequestTransport } from "./transport";

// Covers the getCodingAgentStatus fix: durable task threads (served by
// /api/orchestrator/tasks via OrchestratorTaskService) are folded into the
// status alongside live ACP sessions, and a thread-fetch failure degrades to an
// empty thread list rather than nulling the whole status.

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(handlers: Record<string, () => Response>) {
  const request = vi.fn<AgentRequestTransport["request"]>(async (url) => {
    const { pathname } = new URL(url);
    const handler = handlers[pathname];
    return handler ? handler() : json({});
  });
  const client = new ElizaClient("http://agent.example:31337", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("ElizaClient.getCodingAgentStatus — durable task threads", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
    vi.restoreAllMocks();
  });

  it("folds orchestrator task threads into the status", async () => {
    const client = makeClient({
      "/api/coding-agents": () => json([]),
      "/api/orchestrator/tasks": () =>
        json({ tasks: [{ id: "t1" }, { id: "t2" }] }),
    });

    const status = await client.getCodingAgentStatus();

    expect(status).not.toBeNull();
    expect(status?.taskThreadCount).toBe(2);
    expect(status?.taskThreads).toHaveLength(2);
  });

  it("degrades to empty threads when the orchestrator surface fails (non-fatal)", async () => {
    const client = makeClient({
      "/api/coding-agents": () => json([]),
      "/api/orchestrator/tasks": () => json({ error: "boom" }, 500),
    });

    const status = await client.getCodingAgentStatus();

    expect(status).not.toBeNull();
    expect(status?.taskThreadCount).toBe(0);
    expect(status?.taskThreads).toEqual([]);
  });

  it("returns null when the primary ACP session fetch fails", async () => {
    const client = makeClient({
      "/api/coding-agents": () => json({ error: "down" }, 500),
    });

    await expect(client.getCodingAgentStatus()).resolves.toBeNull();
  });
});
