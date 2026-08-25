/** Verifies context-inspector paging uses a startup-tolerant bounded request through the real typed client seam. */

import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
import "./client-chat";

describe("context inspector client", () => {
  it("preserves paging coordinates and a finite deadline during local startup contention", async () => {
    const client = new ElizaClient("http://agent.example:31337");
    const fetchMock = vi.fn(async () => ({ entries: [] }));
    client.fetch = fetchMock as unknown as typeof client.fetch;

    await client.getContextInspector(
      "00000000-0000-4000-8000-000000000123",
      { offset: 20, limit: 20 },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/context-inspector?conversationId=00000000-0000-4000-8000-000000000123&offset=20&limit=20",
      undefined,
      { timeoutMs: 30_000 },
    );
  });
});
