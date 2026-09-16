/**
 * Unit coverage for uncovered `ElizaClient` verbs contributed by
 * `./client-agent`: bootstrap-exchange status mapping, PTY session lifecycle
 * (spawn/stop/subscribe/resize/legacy scrollback fallback), overlay-layout and
 * stream-source plumbing, and the `chunkPtyInput` cap/surrogate branches not
 * exercised by the shared paste suite. Transport stubbed, no live agent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { chunkPtyInput, MAX_PTY_INPUT_CHUNK_LENGTH } from "./client-agent";
import { ElizaClient } from "./client-base";

function makeClient(): {
  client: ElizaClient;
  sent: Array<Record<string, unknown>>;
} {
  setBootConfig({ branding: {} });
  const client = new ElizaClient("http://agent.example:31337", "token");
  const sent: Array<Record<string, unknown>> = [];
  vi.spyOn(client, "sendWsMessage").mockImplementation(
    (data: Record<string, unknown>) => {
      sent.push(data);
    },
  );
  return { client, sent };
}

function stubFetch(
  client: ElizaClient,
  respond: (
    path: string,
    init?: unknown,
    options?: unknown,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(respond);
  client.fetch = fetchMock as unknown as typeof client.fetch;
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("postBootstrapExchange", () => {
  it("returns a typed success and POSTs the token with allowNonOk parsing", async () => {
    const { client } = makeClient();
    const fetchMock = stubFetch(
      client,
      async () =>
        ({
          sessionId: "sess-1",
          expiresAt: 1893456000000,
          identityId: "id-1",
        }) as Record<string, unknown>,
    );

    const result = await client.postBootstrapExchange("tok-1");

    expect(result).toEqual({
      ok: true,
      sessionId: "sess-1",
      expiresAt: 1893456000000,
      identityId: "id-1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/bootstrap/exchange",
      { method: "POST", body: JSON.stringify({ token: "tok-1" }) },
      { allowNonOk: true },
    );
  });

  it.each([
    ["rate_limited", 429],
    ["db_unavailable", 503],
    ["missing_issuer_env", 503],
    ["missing_container_env", 503],
    ["missing_token", 400],
    ["unrecognized_reason", 401],
  ])("maps reason %s to status %s", async (reason, status) => {
    const { client } = makeClient();
    stubFetch(
      client,
      async () => ({ error: "boom", reason }) as Record<string, unknown>,
    );

    const result = await client.postBootstrapExchange("tok-1");

    expect(result).toEqual({
      ok: false,
      status,
      error: "boom",
      reason,
    });
  });

  it("falls back to the generic error when the failure body omits one", async () => {
    const { client } = makeClient();
    stubFetch(client, async () => ({}) as Record<string, unknown>);

    const result = await client.postBootstrapExchange("tok-1");

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "exchange_failed",
    });
  });

  it("rejects a partial success body instead of faking a session", async () => {
    const { client } = makeClient();
    stubFetch(
      client,
      async () => ({ sessionId: "only-sid" }) as Record<string, unknown>,
    );

    const result = await client.postBootstrapExchange("tok-1");

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "exchange_failed",
    });
  });
});

describe("pair", () => {
  it("binds the submitted code to the instance advertised by auth status", async () => {
    const { client } = makeClient();
    vi.spyOn(client, "getAuthStatus").mockResolvedValue({
      required: true,
      pairingEnabled: true,
      expiresAt: Date.now() + 60_000,
      instanceId: "instance-a",
    });
    const fetchMock = stubFetch(client, async () => ({
      token: "session-a",
      instanceId: "instance-a",
    }));

    await expect(client.pair("ABCD-EFGH-JKLM")).resolves.toEqual({
      token: "session-a",
      instanceId: "instance-a",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/pair", {
      method: "POST",
      body: JSON.stringify({
        code: "ABCD-EFGH-JKLM",
        instanceId: "instance-a",
      }),
    });
  });

  it("fails before posting when status cannot identify the target instance", async () => {
    const { client } = makeClient();
    vi.spyOn(client, "getAuthStatus").mockResolvedValue({
      required: true,
      pairingEnabled: true,
      expiresAt: null,
    });
    const fetchMock = stubFetch(client, async () => ({}));

    await expect(client.pair("ABCD-EFGH-JKLM")).rejects.toMatchObject({
      code: "PAIRING_NOT_READY",
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a success response from a different replica", async () => {
    const { client } = makeClient();
    vi.spyOn(client, "getAuthStatus").mockResolvedValue({
      required: true,
      pairingEnabled: true,
      expiresAt: Date.now() + 60_000,
      instanceId: "instance-a",
    });
    stubFetch(client, async () => ({
      token: "session-b",
      instanceId: "instance-b",
    }));

    await expect(client.pair("ABCD-EFGH-JKLM")).rejects.toMatchObject({
      code: "PAIRING_INSTANCE_MISMATCH",
      status: 409,
    });
  });
});

describe("PTY session lifecycle verbs", () => {
  it("spawns a PTY session by POSTing the JSON options and unwrapping sessionId", async () => {
    const { client } = makeClient();
    const fetchMock = stubFetch(
      client,
      async () =>
        ({ session: { sessionId: "pty-9" } }) as Record<string, unknown>,
    );

    const result = await client.spawnPtySession({ kind: "eliza-code" });

    expect(result).toEqual({ sessionId: "pty-9" });
    expect(fetchMock).toHaveBeenCalledWith("/api/pty/sessions", {
      method: "POST",
      body: JSON.stringify({ kind: "eliza-code" }),
    });
  });

  it("serializes omitted spawn options into an empty JSON object body", async () => {
    const { client } = makeClient();
    const fetchMock = stubFetch(
      client,
      async () =>
        ({ session: { sessionId: "pty-0" } }) as Record<string, unknown>,
    );

    const result = await client.spawnPtySession();

    expect(result).toEqual({ sessionId: "pty-0" });
    expect(fetchMock).toHaveBeenCalledWith("/api/pty/sessions", {
      method: "POST",
      body: "{}",
    });
  });

  it("stops a session with DELETE against the URI-encoded path", async () => {
    const { client } = makeClient();
    const fetchMock = stubFetch(
      client,
      async () => ({ ok: true }) as Record<string, unknown>,
    );

    const result = await client.stopPtySession("a b/c");

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/pty/sessions/a%20b%2Fc", {
      method: "DELETE",
    });
  });

  it("translates a failed stop request into an explicit false", async () => {
    const { client } = makeClient();
    client.fetch = vi.fn(async () => {
      throw new Error("agent offline");
    });

    const result = await client.stopPtySession("sess-1");

    expect(result).toBe(false);
  });

  it("sends exact WS frames for subscribe, unsubscribe, and resize in call order", () => {
    const { client, sent } = makeClient();

    client.subscribePtyOutput("s-1");
    client.resizePty("s-1", 132, 43);
    client.unsubscribePtyOutput("s-1");

    expect(sent).toEqual([
      { type: "pty-subscribe", sessionId: "s-1" },
      { type: "pty-resize", sessionId: "s-1", cols: 132, rows: 43 },
      { type: "pty-unsubscribe", sessionId: "s-1" },
    ]);
  });
});

describe("getPtyBufferedOutput scrollback hydration", () => {
  it("returns primary-route output verbatim", async () => {
    const { client } = makeClient();
    const fetchMock = stubFetch(client, async (path) => {
      if (path === "/api/pty/sessions/s-1/buffered-output") {
        return { output: "scrollback text" };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await client.getPtyBufferedOutput("s-1");

    expect(result).toBe("scrollback text");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes a missing output field on the primary route without falling back", async () => {
    const { client } = makeClient();
    const fetchMock = stubFetch(client, async (path) => {
      if (path === "/api/pty/sessions/s-1/buffered-output") {
        return { output: null };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await client.getPtyBufferedOutput("s-1");

    expect(result).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries older coding-agent sessions behind the legacy route", async () => {
    const { client } = makeClient();
    const seenPaths: string[] = [];
    stubFetch(client, async (path) => {
      seenPaths.push(path);
      if (path === "/api/pty/sessions/old-1/buffered-output") {
        throw new Error("404 — legacy session");
      }
      return { output: "legacy scrollback" };
    });

    const result = await client.getPtyBufferedOutput("old-1");

    expect(result).toBe("legacy scrollback");
    expect(seenPaths).toEqual([
      "/api/pty/sessions/old-1/buffered-output",
      "/api/coding-agents/old-1/buffered-output",
    ]);
  });

  it("degrades to an empty replay when both routes fail", async () => {
    const { client } = makeClient();
    client.fetch = vi.fn(async () => {
      throw new Error("agent unreachable");
    });

    const result = await client.getPtyBufferedOutput("s-1");

    expect(result).toBe("");
  });

  it("URI-encodes the sessionId on both routes", async () => {
    const { client } = makeClient();
    const seenPaths: string[] = [];
    stubFetch(client, async (path) => {
      seenPaths.push(path);
      if (path.endsWith("buffered-output") && path.includes("coding-agents")) {
        return { output: "ok" };
      }
      throw new Error("use legacy route");
    });

    await client.getPtyBufferedOutput("a b");

    expect(seenPaths[0]).toBe("/api/pty/sessions/a%20b/buffered-output");
    expect(seenPaths[1]).toBe("/api/coding-agents/a%20b/buffered-output");
  });
});

describe("overlay layout and stream source plumbing", () => {
  it("omits the query string when no destination is given for reads", async () => {
    const { client } = makeClient();
    const fetchMock = stubFetch(
      client,
      async () => ({ ok: true, layout: null }) as Record<string, unknown>,
    );

    await client.getOverlayLayout();

    expect(fetchMock).toHaveBeenCalledWith("/api/stream/overlay-layout");
  });

  it("URI-encodes the destination filter on reads and writes", async () => {
    const { client } = makeClient();
    const fetchMock = stubFetch(
      client,
      async () => ({ ok: true }) as Record<string, unknown>,
    );

    await client.getOverlayLayout("dest/1");
    await client.saveOverlayLayout({ left: 1 }, "d 1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/stream/overlay-layout?destination=dest%2F1",
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/stream/overlay-layout?destination=d%201",
      { method: "POST", body: JSON.stringify({ layout: { left: 1 } }) },
    );
  });

  it("drops an absent customUrl from the serialized stream-source body", async () => {
    const { client } = makeClient();
    const fetchMock = stubFetch(
      client,
      async () => ({ ok: true }) as Record<string, unknown>,
    );

    await client.setStreamSource("camera");

    expect(fetchMock).toHaveBeenCalledWith("/api/stream/source", {
      method: "POST",
      body: '{"sourceType":"camera"}',
    });
  });

  it("keeps a provided customUrl in the stream-source body", async () => {
    const { client } = makeClient();
    const fetchMock = stubFetch(
      client,
      async () => ({ ok: true }) as Record<string, unknown>,
    );

    await client.setStreamSource("custom", "rtsp://host/stream");

    expect(fetchMock).toHaveBeenCalledWith("/api/stream/source", {
      method: "POST",
      body: JSON.stringify({
        sourceType: "custom",
        customUrl: "rtsp://host/stream",
      }),
    });
  });
});

describe("chunkPtyInput — cap boundaries beyond the shared paste suite", () => {
  it("pins the exported default cap at the server's 4096-unit limit", () => {
    expect(MAX_PTY_INPUT_CHUNK_LENGTH).toBe(4096);
  });

  it("honors an explicit smaller maxLength", () => {
    expect(chunkPtyInput("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(chunkPtyInput("abcde", 5)).toEqual(["abcde"]);
    expect(chunkPtyInput("abcdef", 5)).toEqual(["abcde", "f"]);
  });

  it("leaves the cut alone when a LOW surrogate sits at the boundary", () => {
    // The pair's low half at end-1 is not a high surrogate, so the chunker
    // keeps the natural cut — which here still contains the whole pair.
    expect(chunkPtyInput("\uD83D\uDE00ab", 2)).toEqual(["\uD83D\uDE00", "ab"]);
  });

  it("documents the degenerate width-1 guard that splits pairs into lone surrogates", () => {
    // The end - start > 1 guard disables surrogate handling entirely at
    // width 1; each UTF-16 unit becomes its own chunk. Observed behavior.
    expect(chunkPtyInput("\uD83D\uDE00x", 1)).toEqual([
      "\uD83D",
      "\uDE00",
      "x",
    ]);
  });

  it("reassembles mixed ASCII and emoji under a small odd cap", () => {
    const input = `log ${"x".repeat(17)} done \u{1F600} tail`;
    const chunks = chunkPtyInput(input, 5);

    expect(chunks.join("")).toBe(input);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(5);
    }
  });
});
