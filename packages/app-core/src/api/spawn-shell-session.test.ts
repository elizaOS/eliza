// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client";

/**
 * Regression test for the shell-session spawn response shape.
 *
 * The server route `POST /api/coding-agents/spawn` returns the session id
 * at the top level as `{ sessionId, agentType, workdir, status }`. An
 * earlier version of the client decoded this as `{ session: { id } }`,
 * which produced `TypeError: Cannot read properties of undefined` at
 * runtime, silently swallowed by callers' try/catch — so users saw the
 * Terminal channel stuck on "Starting terminal…" forever.
 *
 * This test pins the contract: if someone changes the server shape or
 * the client decoder again, it fails loudly.
 */
describe("ElizaClient.spawnShellSession", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    // biome-ignore lint/suspicious/noExplicitAny: test shim
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test shim
    (globalThis as any).fetch = originalFetch;
  });

  it("parses the top-level `sessionId` field from the server response", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          sessionId: "pty-123",
          agentType: "shell",
          workdir: "/tmp",
          status: "starting",
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const client = new ElizaClient({ baseUrl: "http://127.0.0.1:31337" });
    const result = await client.spawnShellSession();

    expect(result).toEqual({ sessionId: "pty-123" });

    // POSTs to the spawn endpoint with agentType=shell.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/coding-agents\/spawn$/);
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ agentType: "shell" });
  });

  it("includes workdir in the POST body when supplied", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ sessionId: "pty-with-workdir" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new ElizaClient({ baseUrl: "http://127.0.0.1:31337" });
    const result = await client.spawnShellSession("/Users/someone/repo");

    expect(result.sessionId).toBe("pty-with-workdir");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      agentType: "shell",
      workdir: "/Users/someone/repo",
    });
  });
});
