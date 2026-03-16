/**
 * Tests for cloud/bridge-client.ts — the Eliza Cloud API client.
 *
 * Exercises:
 *   - Agent CRUD (list, create, get, delete)
 *   - sendMessage (JSON-RPC success, error, timeout)
 *   - sendMessageStream (SSE parsing, multiple chunks, error events)
 *   - heartbeat (success, failure)
 *   - snapshot / restore / listBackups
 *   - HTTP error handling across all methods
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaCloudClient } from "./bridge-client";

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

const fetchMock =
  vi.fn<
    (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  >();

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("crypto", { randomUUID: () => "test-uuid-1234" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(
  events: Array<{ event?: string; data: unknown }>,
): Response {
  const body = `${events
    .map((e) => {
      const lines: string[] = [];
      if (e.event) lines.push(`event: ${e.event}`);
      lines.push(`data: ${JSON.stringify(e.data)}`);
      return lines.join("\n");
    })
    .join("\n\n")}\n\n`;

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const client = new ElizaCloudClient(
  "https://test.elizacloud.ai",
  "eliza_testkey",
);

// ---------------------------------------------------------------------------
// Agent CRUD
// ---------------------------------------------------------------------------

describe("Agent CRUD", () => {
  it("listAgents returns array from data field", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: [
          {
            id: "a1",
            agentName: "Agent1",
            status: "running",
            createdAt: "2025-01-01",
          },
        ],
      }),
    );

    const agents = await client.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("a1");
    expect(agents[0].agentName).toBe("Agent1");

    // Verify correct URL and auth header
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://test.elizacloud.ai/api/v1/milady/agents");
    expect((opts?.headers as Record<string, string>)["X-Api-Key"]).toBe(
      "eliza_testkey",
    );
    expect(opts?.redirect).toBe("manual");
  });

  it("listAgents returns empty array on empty response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    const agents = await client.listAgents();
    expect(agents).toEqual([]);
  });

  it("createAgent sends correct body and returns agent", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          success: true,
          data: { id: "new-agent", agentName: "TestBot", status: "pending" },
        },
        201,
      ),
    );

    const agent = await client.createAgent({ agentName: "TestBot" });
    expect(agent.agentName).toBe("TestBot");

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.agentName).toBe("TestBot");
  });

  it("createAgent throws on failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: "Quota exceeded" }, 403),
    );
    await expect(client.createAgent({ agentName: "X" })).rejects.toThrow(
      "Quota exceeded",
    );
  });

  it("getAgent returns agent details", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { id: "a1", agentName: "Bot", status: "running" },
      }),
    );

    const agent = await client.getAgent("a1");
    expect(agent.id).toBe("a1");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/agents/a1");
  });

  it("getAgent throws when not found", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: "Agent not found" }, 404),
    );
    await expect(client.getAgent("nonexistent")).rejects.toThrow(
      "Agent not found",
    );
  });

  it("deleteAgent sends DELETE request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await client.deleteAgent("a1");
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(lastCall[1]?.method).toBe("DELETE");
  });
});

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

describe("sendMessage", () => {
  it("extracts text from JSON-RPC result", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: "test-uuid-1234",
        result: { text: "Hello from the cloud!", metadata: { timestamp: 123 } },
      }),
    );

    const reply = await client.sendMessage("a1", "Hi", "room1");
    expect(reply).toBe("Hello from the cloud!");

    // Verify JSON-RPC payload
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse(lastCall[1]?.body as string);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("message.send");
    expect(body.params.text).toBe("Hi");
    expect(body.params.roomId).toBe("room1");
    expect(body.params.channelType).toBe("DM");
  });

  it("uses default roomId when not specified", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        result: { text: "ok" },
      }),
    );

    await client.sendMessage("a1", "Hello");
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse(lastCall[1]?.body as string);
    expect(body.params.roomId).toBe("web-chat");
    expect(body.params.channelType).toBe("DM");
  });

  it("returns '(no response)' when result has no text", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        result: {},
      }),
    );

    const reply = await client.sendMessage("a1", "Hi");
    expect(reply).toBe("(no response)");
  });

  it("throws on JSON-RPC error", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Agent runtime not ready" },
      }),
    );

    await expect(client.sendMessage("a1", "Hi")).rejects.toThrow(
      "Agent runtime not ready",
    );
  });

  it("throws on HTTP error", async () => {
    fetchMock.mockResolvedValue(
      new Response("Service Unavailable", { status: 503 }),
    );
    await expect(client.sendMessage("a1", "Hi")).rejects.toThrow("HTTP 503");
  });

  it("rejects redirect responses", async () => {
    fetchMock.mockResolvedValue(
      new Response("", {
        status: 302,
        headers: { location: "https://evil.example" },
      }),
    );
    await expect(client.sendMessage("a1", "Hi")).rejects.toThrow("redirected");
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(lastCall[1]?.redirect).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// sendMessageStream
// ---------------------------------------------------------------------------

describe("sendMessageStream", () => {
  it("yields text chunks from SSE events", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        { event: "connected", data: { agentId: "a1" } },
        { event: "chunk", data: { text: "Once upon" } },
        { event: "chunk", data: { text: " a time" } },
        { event: "done", data: {} },
      ]),
    );

    const chunks: string[] = [];
    for await (const event of client.sendMessageStream(
      "a1",
      "Tell me a story",
    )) {
      if (event.type === "chunk" && typeof event.data.text === "string") {
        chunks.push(event.data.text);
      }
    }

    expect(chunks).toEqual(["Once upon", " a time"]);
  });

  it("yields all event types including connected and done", async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        { event: "connected", data: { agentId: "a1" } },
        { event: "chunk", data: { text: "Hi" } },
        { event: "done", data: { rpcId: "123" } },
      ]),
    );

    const types: string[] = [];
    for await (const event of client.sendMessageStream("a1", "Hello")) {
      types.push(event.type);
    }

    expect(types).toEqual(["connected", "chunk", "done"]);
  });

  it("handles empty stream gracefully", async () => {
    fetchMock.mockResolvedValue(
      new Response("", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const events: unknown[] = [];
    for await (const event of client.sendMessageStream("a1", "Hello")) {
      events.push(event);
    }

    expect(events).toEqual([]);
  });

  it("throws on HTTP error", async () => {
    fetchMock.mockResolvedValue(new Response("Bad Gateway", { status: 502 }));

    const gen = client.sendMessageStream("a1", "Hello");
    await expect(gen.next()).rejects.toThrow("Stream request failed: HTTP 502");
  });

  it("rejects redirect responses", async () => {
    fetchMock.mockResolvedValue(
      new Response("", {
        status: 307,
        headers: { location: "https://evil.example" },
      }),
    );

    const gen = client.sendMessageStream("a1", "Hello");
    await expect(gen.next()).rejects.toThrow("redirected");

    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(lastCall[1]?.redirect).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

describe("heartbeat", () => {
  it("returns true on successful response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        method: "heartbeat.ack",
      }),
    );

    const alive = await client.heartbeat("a1");
    expect(alive).toBe(true);

    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse(lastCall[1]?.body as string);
    expect(body.method).toBe("heartbeat");
  });

  it("returns false on HTTP error", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 503 }));
    const alive = await client.heartbeat("a1");
    expect(alive).toBe(false);
  });

  it("returns false on network failure", async () => {
    fetchMock.mockRejectedValue(new Error("Network unreachable"));
    // heartbeat catches fetch errors and returns false
    const alive = await client.heartbeat("a1");
    expect(alive).toBe(false);
  });

  it("returns false on redirect responses", async () => {
    fetchMock.mockResolvedValue(
      new Response("", {
        status: 302,
        headers: { location: "https://evil.example" },
      }),
    );

    const alive = await client.heartbeat("a1");
    expect(alive).toBe(false);

    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(lastCall[1]?.redirect).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// Snapshot / Backup
// ---------------------------------------------------------------------------

describe("snapshot and backups", () => {
  it("snapshot sends POST and returns backup info", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          id: "bk-1",
          snapshotType: "manual",
          sizeBytes: 1024,
          createdAt: "2025-01-01",
        },
      }),
    );

    const backup = await client.snapshot("a1");
    expect(backup.id).toBe("bk-1");
    expect(backup.snapshotType).toBe("manual");
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(lastCall[1]?.method).toBe("POST");
  });

  it("snapshot throws on failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: "Sandbox is not running" }, 409),
    );
    await expect(client.snapshot("a1")).rejects.toThrow(
      "Sandbox is not running",
    );
  });

  it("listBackups returns array", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: [
          { id: "bk-1", snapshotType: "auto", sizeBytes: 512 },
          { id: "bk-2", snapshotType: "manual", sizeBytes: 1024 },
        ],
      }),
    );

    const backups = await client.listBackups("a1");
    expect(backups).toHaveLength(2);
  });

  it("restore sends POST with optional backupId", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));

    await client.restore("a1", "bk-specific");
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse(lastCall[1]?.body as string);
    expect(body.backupId).toBe("bk-specific");
  });

  it("restore sends POST without backupId for latest", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));

    await client.restore("a1");
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const body = JSON.parse(lastCall[1]?.body as string);
    expect(body).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// provision
// ---------------------------------------------------------------------------

describe("provision", () => {
  it("returns provision info on success", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          id: "a1",
          agentName: "Bot",
          status: "running",
          bridgeUrl: "https://sb.test",
        },
      }),
    );

    const info = await client.provision("a1");
    expect(info.status).toBe("running");
    expect(info.bridgeUrl).toBe("https://sb.test");
  });

  it("throws on provision failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: "Health check timed out" }, 500),
    );
    await expect(client.provision("a1")).rejects.toThrow(
      "Health check timed out",
    );
  });
});
