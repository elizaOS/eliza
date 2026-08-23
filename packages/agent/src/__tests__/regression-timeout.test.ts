/**
 * Behavioral regression for fetch timeout — media-store and cloud fetches.
 * Proves DEFAULT_*_TIMEOUT_MS budgets, hanging-fetch abort via TimeoutError,
 * body-stall abort through response.json(), and caller-signal composition.
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MEDIA_FETCH_TIMEOUT_MS,
  fetchRemoteMedia,
} from "../../../core/src/media/fetch.ts";
import { DEFAULT_MEDIA_REHOST_FETCH_TIMEOUT_MS } from "../api/media-runtime.ts";
import {
  autoFetchCloudGithubToken,
  autoResolveDiscordAppId,
  DEFAULT_CLOUD_FETCH_TIMEOUT_MS,
  DEFAULT_CLOUD_GITHUB_TOKEN_FETCH_TIMEOUT_MS,
  fetchJsonWithCloudTimeout,
} from "../runtime/eliza.ts";

// Preserve original AbortSignal.timeout for 10ms acceleration
let originalTimeout: typeof AbortSignal.timeout;

function stallUntilAborted(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (!signal) throw new Error("expected abort signal");
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as unknown as typeof fetch;
}

function stallingPinnedFetch(): NonNullable<
  Parameters<typeof fetchRemoteMedia>[0]["pinnedFetchImpl"]
> {
  // For fetchRemoteMedia's pinnedFetchImpl shape, we adapt to its params
  return async ({ init }) => {
    const signal = init.signal as AbortSignal | undefined;
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) throw new Error("expected signal in pinned fetch");
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
}

describe("fetch timeout regression — media-store and cloud", () => {
  beforeEach(() => {
    originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("exposes documented ten-second budgets", () => {
    expect(DEFAULT_MEDIA_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_MEDIA_REHOST_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_CLOUD_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_CLOUD_GITHUB_TOKEN_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it('aborts a stalled media fetch at the deadline (hanging pinned fetch) — vi.spyOn(AbortSignal,"timeout") →10ms + stallUntilAborted', async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) =>
      ms === DEFAULT_MEDIA_FETCH_TIMEOUT_MS
        ? originalTimeout(10)
        : originalTimeout(ms),
    );
    await expect(
      fetchRemoteMedia({
        url: "https://example.com/image.png",
        maxBytes: 1024 * 1024,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
        pinnedFetchImpl: stallingPinnedFetch(),
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    expect(vi.spyOn(AbortSignal, "timeout")).toHaveBeenCalled;
    // Explicitly check spy was called with DEFAULT
    expect(
      AbortSignal.timeout as unknown as ReturnType<typeof vi.spyOn>,
    ).toHaveBeenCalledWith(DEFAULT_MEDIA_FETCH_TIMEOUT_MS);
  });

  it("aborts a stalled cloud fetch at the deadline (hanging fetch) via fetchJsonWithCloudTimeout", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) =>
      ms === DEFAULT_CLOUD_FETCH_TIMEOUT_MS
        ? originalTimeout(10)
        : originalTimeout(ms),
    );
    const hanging = stallUntilAborted();
    await expect(
      fetchJsonWithCloudTimeout(
        "https://cloud.example.test/json",
        {},
        { fetchImpl: hanging as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(
      DEFAULT_CLOUD_FETCH_TIMEOUT_MS,
    );
  });

  it("keeps the deadline armed while the media response body stalls (real server) — body-stall", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": "100",
      });
      res.write(Buffer.alloc(10));
      // stall body — never end, deadline must abort readResponseWithLimit
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/image.png`;

    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(10),
    );

    try {
      await expect(
        fetchRemoteMedia({
          url,
          maxBytes: 1024 * 1024,
          ssrfPolicy: { allowPrivateNetwork: true },
        }),
      ).rejects.toSatisfy((err: unknown) => {
        const e = err as {
          name?: string;
          cause?: { name?: string };
          code?: string;
          message?: string;
        };
        return (
          e?.cause?.name === "TimeoutError" ||
          e?.name === "TimeoutError" ||
          e?.name === "AbortError" ||
          e?.code === "ECONNRESET" ||
          (typeof e?.message === "string" &&
            e.message.toLowerCase().includes("aborted"))
        );
      });
      expect(AbortSignal.timeout).toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the deadline armed while the cloud response body stalls through response.json() (real server)", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"success":true,"data":{"accessToken":"x",');
      // never finish JSON — response.json() must abort via TimeoutError
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/token`;

    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(10),
    );

    try {
      await expect(
        fetchJsonWithCloudTimeout(url, {}, { fetchImpl: globalThis.fetch }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("preserves caller AbortError over TimeoutError via AbortSignal.any([caller, timeout])", async () => {
    const caller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(1000),
    );
    const hanging = stallUntilAborted();
    const pending = fetchJsonWithCloudTimeout(
      "https://cloud.example.test/json",
      {},
      {
        signal: caller.signal,
        fetchImpl: hanging as unknown as typeof fetch,
      },
    );
    caller.abort(new DOMException("caller abort", "AbortError"));
    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: "caller abort",
    });
    // Verify any composition was used — timeout spy still called
    expect(AbortSignal.timeout).toHaveBeenCalledWith(
      DEFAULT_CLOUD_FETCH_TIMEOUT_MS,
    );
  });

  it("also preserves caller abort for media fetch via AbortSignal.any([caller, timeout])", async () => {
    const caller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      originalTimeout(1000),
    );
    const pending = fetchRemoteMedia({
      url: "https://example.com/media.png",
      maxBytes: 1024 * 1024,
      signal: caller.signal,
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedFetchImpl: stallingPinnedFetch(),
    });
    caller.abort(new DOMException("media caller abort", "AbortError"));
    await expect(pending).rejects.toMatchObject({
      cause: expect.objectContaining({ name: "AbortError" }),
    });
  });

  it("does not call fetch when cloud github token is skipped due to existing env — not.toHaveBeenCalled()", async () => {
    vi.stubEnv("GITHUB_TOKEN", "existing-token");
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "cloud-key");
    vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://cloud.test");
    vi.stubEnv("ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT", "managed");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await autoFetchCloudGithubToken("agent-1");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call fetch when discord app id already set — not.toHaveBeenCalled() again", async () => {
    vi.stubEnv("DISCORD_APPLICATION_ID", "already-set");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await autoResolveDiscordAppId("token-override");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("succeeds on fast cloud upstream and passes abort signal, not aborted", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (!init?.signal) throw new Error("signal missing");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const result = await fetchJsonWithCloudTimeout(
      "https://cloud.example.test/ok",
      {},
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
    );
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit)
      ?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
  });
});
