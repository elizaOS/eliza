import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLocalAgentProbeCache,
  DEFAULT_LOCAL_AGENT_HEALTH_URL,
  probeLocalAgent,
} from "../../src/onboarding/probe-local-agent";

describe("probeLocalAgent", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearLocalAgentProbeCache();
    fetchMock = vi.fn();
    (globalThis as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    clearLocalAgentProbeCache();
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    vi.useRealTimers();
  });

  it("returns true when the agent reports HTTP 200 with {ok:true}", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(probeLocalAgent(500)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(calledUrl).toBe(DEFAULT_LOCAL_AGENT_HEALTH_URL);
  });

  it("returns false on a non-200 response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));
    await expect(probeLocalAgent(500)).resolves.toBe(false);
  });

  it("returns false when the response is HTTP 200 but JSON does not say ok:true", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(probeLocalAgent(500)).resolves.toBe(false);
  });

  it("returns false when the response body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>nope</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    await expect(probeLocalAgent(500)).resolves.toBe(false);
  });

  it("returns false on a network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(probeLocalAgent(500)).resolves.toBe(false);
  });

  it("returns false when the request times out (AbortController fires)", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    await expect(probeLocalAgent(20)).resolves.toBe(false);
  });

  it("memoizes the result so a second call within the TTL does not refetch", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(probeLocalAgent(500)).resolves.toBe(true);
    await expect(probeLocalAgent(500)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clearLocalAgentProbeCache forces a fresh probe", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(probeLocalAgent(500)).resolves.toBe(true);
    clearLocalAgentProbeCache();

    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));
    await expect(probeLocalAgent(500)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes inflight probes for the same URL", async () => {
    let resolveBody: (r: Response) => void = () => {};
    const slow = new Promise<Response>((resolve) => {
      resolveBody = resolve;
    });
    fetchMock.mockReturnValueOnce(slow);

    const first = probeLocalAgent(500);
    const second = probeLocalAgent(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveBody(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });
});
