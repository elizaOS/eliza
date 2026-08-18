/**
 * Exercises the content-pack manifest deadline, provider errors, successful
 * body consumption, and the exported URL-loader wiring.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/shared", () => ({
  CONTENT_PACK_MANIFEST_FILENAME: "pack.json",
  validateContentPackManifest: () => [],
}));

import {
  CONTENT_PACK_MANIFEST_FETCH_TIMEOUT_MS,
  ContentPackLoadError,
  getContentPackManifestJsonWithFetch,
  loadContentPackFromUrl,
} from "./load-pack";

const MANIFEST_URL = "https://example.com/packs/cyberpunk-neon/pack.json";

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected content-pack abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("content-pack manifest deadline", () => {
  it("keeps a documented UI fetch budget", () => {
    expect(CONTENT_PACK_MANIFEST_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled manifest GET at the injected deadline", async () => {
    await expect(
      getContentPackManifestJsonWithFetch(
        MANIFEST_URL,
        stallUntilAborted(),
        10,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("keeps the same deadline active while the response body stalls", async () => {
    const fetchImpl: typeof fetch = async (_input, init) =>
      ({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error("expected content-pack abort signal");
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      }) as Response;

    await expect(
      getContentPackManifestJsonWithFetch(MANIFEST_URL, fetchImpl, 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed manifest GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    await expect(
      getContentPackManifestJsonWithFetch(MANIFEST_URL, fetchImpl, 1_000),
    ).rejects.toThrow("503");
  });

  it("consumes successful JSON with a live, non-aborted signal", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ id: "cyberpunk-neon" });
    };

    await expect(
      getContentPackManifestJsonWithFetch<{ id: string }>(
        MANIFEST_URL,
        fetchImpl,
        1_000,
      ),
    ).resolves.toEqual({ id: "cyberpunk-neon" });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("wires the exported URL loader through the bounded fetch seam", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({
        id: "cyberpunk-neon",
        name: "Cyberpunk Neon",
        version: "1.0.0",
        assets: {},
      });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const pack = await loadContentPackFromUrl(
      "https://example.com/packs/cyberpunk-neon",
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(MANIFEST_URL);
    expect(pack.source).toEqual({
      kind: "url",
      url: "https://example.com/packs/cyberpunk-neon/",
    });
  });

  it("preserves the loader's structured boundary error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Promise.reject(new DOMException("deadline", "TimeoutError")),
      ),
    );

    const error = await loadContentPackFromUrl(
      "https://example.com/packs/cyberpunk-neon/",
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ContentPackLoadError);
    expect(error).toMatchObject({
      source: {
        kind: "url",
        url: "https://example.com/packs/cyberpunk-neon/",
      },
      cause: { name: "TimeoutError" },
    });
  });
});
