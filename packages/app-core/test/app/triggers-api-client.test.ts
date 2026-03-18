import { ElizaClient } from "@elizaos/app-core/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("ElizaClient trigger endpoints", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, triggers: [], runs: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("calls trigger list endpoint", async () => {
    const client = new ElizaClient("http://localhost:2138", "token");
    await client.getTriggers();

    const firstCall = fetchMock.mock.calls[0];
    expect(String(firstCall[0])).toBe("http://localhost:2138/api/triggers");
    expect(firstCall[1]?.method).toBeUndefined();
  });

  test("calls trigger mutation endpoints with expected methods", async () => {
    const client = new ElizaClient("http://localhost:2138", "token");

    await client.createTrigger({
      displayName: "Heartbeat",
      instructions: "Post heartbeat",
      triggerType: "interval",
      intervalMs: 120000,
    });
    await client.updateTrigger("id-1", { enabled: false });
    await client.runTriggerNow("id-1");
    await client.getTriggerRuns("id-1");
    await client.getTriggerHealth();
    await client.deleteTrigger("id-1");

    const calls = fetchMock.mock.calls.map((call) => ({
      url: String(call[0]),
      method: (call[1]?.method as string | undefined) ?? "GET",
    }));

    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/triggers",
      method: "POST",
    });
    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/triggers/id-1",
      method: "PUT",
    });
    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/triggers/id-1/execute",
      method: "POST",
    });
    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/triggers/id-1/runs",
      method: "GET",
    });
    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/triggers/health",
      method: "GET",
    });
    expect(calls).toContainEqual({
      url: "http://localhost:2138/api/triggers/id-1",
      method: "DELETE",
    });
  });
});
