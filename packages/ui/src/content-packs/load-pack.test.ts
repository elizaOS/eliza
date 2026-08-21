/**
 * Exercises remote content-pack loading through mocked Fetch boundaries,
 * including caller cancellation and a deadline that remains active while the
 * response body is consumed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/shared", () => ({
  CONTENT_PACK_MANIFEST_FILENAME: "pack.json",
  validateContentPackManifest: (value: unknown) =>
    value && typeof value === "object"
      ? []
      : [{ field: "root", message: "invalid" }],
}));

import {
  CONTENT_PACK_MANIFEST_MAX_BYTES,
  ContentPackLoadError,
  getContentPackManifestJsonWithFetch,
  loadContentPackFromUrl,
} from "./load-pack";

const MANIFEST = {
  id: "cyberpunk-neon",
  name: "Cyberpunk Neon",
  version: "1.0.0",
  assets: {},
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadContentPackFromUrl", () => {
  it("loads and resolves a valid remote manifest", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(MANIFEST));

    const pack = await loadContentPackFromUrl(
      "https://example.com/packs/cyberpunk-neon",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/packs/cyberpunk-neon/pack.json",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(pack.manifest).toEqual(MANIFEST);
    expect(pack.source).toEqual({
      kind: "url",
      url: "https://example.com/packs/cyberpunk-neon/",
    });
  });

  it("preserves caller cancellation as the load error cause", async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );

    const pending = loadContentPackFromUrl("https://example.com/packs/a", {
      signal: controller.signal,
    });
    const reason = new DOMException("superseded", "AbortError");
    controller.abort(reason);

    await expect(pending).rejects.toMatchObject({
      name: "ContentPackLoadError",
      cause: reason,
    });
  });

  it("keeps the deadline active through response-body consumption", async () => {
    const timeoutController = new AbortController();
    let markBodyStarted!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutController.signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              markBodyStarted();
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(init.signal?.reason),
                { once: true },
              );
            },
          }),
        ),
    );

    const pending = loadContentPackFromUrl("https://example.com/packs/a");
    await bodyStarted;
    const reason = new DOMException("timed out", "TimeoutError");
    timeoutController.abort(reason);

    await expect(pending).rejects.toMatchObject({
      name: "ContentPackLoadError",
      cause: reason,
    });
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });

  it("wraps completed provider failures with their source", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    const error = await loadContentPackFromUrl(
      "https://example.com/packs/a",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ContentPackLoadError);
    expect(error).toMatchObject({
      source: { kind: "url", url: "https://example.com/packs/a/" },
      cause: expect.objectContaining({
        message: expect.stringContaining("503"),
      }),
    });
  });

  it("cancels a body that ignores the request signal when the deadline expires", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ pull() {}, cancel });
    const fetchImpl: typeof fetch = async () => new Response(body);

    await expect(
      getContentPackManifestJsonWithFetch(
        "https://example.com/pack.json",
        fetchImpl,
        10,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("rejects and cancels a chunked body as soon as it crosses the byte cap", async () => {
    let requestSignal: AbortSignal | undefined;
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
      },
      cancel,
    });
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(body);
    };

    await expect(
      getContentPackManifestJsonWithFetch(
        "https://example.com/pack.json",
        fetchImpl,
        1_000,
        10,
      ),
    ).rejects.toMatchObject({ name: "ContentPackManifestTooLargeError" });
    expect(requestSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("releases the reader when cancellation rejects", async () => {
    const cancellationFailure = new Error("cancel failed");
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(11));
      },
      cancel: () => Promise.reject(cancellationFailure),
    });
    const fetchImpl: typeof fetch = async () => new Response(body);

    await expect(
      getContentPackManifestJsonWithFetch(
        "https://example.com/pack.json",
        fetchImpl,
        1_000,
        10,
      ),
    ).rejects.toMatchObject({ name: "ContentPackManifestTooLargeError" });
    expect(body.locked).toBe(false);
  });

  it("bounds decompressed bytes despite a smaller declared wire size", async () => {
    const cancel = vi.fn();
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(11));
          },
          cancel,
        }),
        {
          headers: {
            "content-encoding": "gzip",
            "content-length": "2",
          },
        },
      );

    await expect(
      getContentPackManifestJsonWithFetch(
        "https://example.com/pack.json",
        fetchImpl,
        1_000,
        10,
      ),
    ).rejects.toMatchObject({ name: "ContentPackManifestTooLargeError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects and cancels a declared oversized body before reading", async () => {
    const cancel = vi.fn();
    const fetchImpl: typeof fetch = async () =>
      ({
        ok: true,
        headers: new Headers({ "content-length": "11" }),
        body: new ReadableStream({ cancel }),
      }) as Response;

    await expect(
      getContentPackManifestJsonWithFetch(
        "https://example.com/pack.json",
        fetchImpl,
        1_000,
        10,
      ),
    ).rejects.toMatchObject({ name: "ContentPackManifestTooLargeError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("accepts valid multi-byte JSON split across chunks at the exact cap", async () => {
    const bytes = new TextEncoder().encode('{"value":"€"}');
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, bytes.length - 2));
        controller.enqueue(bytes.subarray(bytes.length - 2));
        controller.close();
      },
    });
    const fetchImpl: typeof fetch = async () => new Response(body);

    await expect(
      getContentPackManifestJsonWithFetch(
        "https://example.com/pack.json",
        fetchImpl,
        1_000,
        bytes.length,
      ),
    ).resolves.toEqual({ value: "€" });
    expect(body.locked).toBe(false);
  });

  it("rejects malformed UTF-8 instead of repairing manifest text", async () => {
    const malformedJson = new Uint8Array([
      0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d,
    ]);
    const fetchImpl: typeof fetch = async () => new Response(malformedJson);

    await expect(
      getContentPackManifestJsonWithFetch(
        "https://example.com/pack.json",
        fetchImpl,
        1_000,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects invalid injected limits instead of disabling the byte cap", async () => {
    const fetchImpl: typeof fetch = async () => Response.json(MANIFEST);

    await expect(
      getContentPackManifestJsonWithFetch(
        "https://example.com/pack.json",
        fetchImpl,
        1_000,
        Number.POSITIVE_INFINITY,
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("omits auth, referrer, and cache reuse for an untrusted pack origin", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(MANIFEST));

    await getContentPackManifestJsonWithFetch(
      "https://example.com/pack.json",
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.com/pack.json",
      expect.objectContaining({
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      }),
    );
  });

  it("surfaces the byte-limit reason through the loader boundary", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(), {
        headers: {
          "content-length": String(CONTENT_PACK_MANIFEST_MAX_BYTES + 1),
        },
      }),
    );

    const error = await loadContentPackFromUrl(
      "https://example.com/packs/a",
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ContentPackLoadError);
    expect(error).toMatchObject({
      message: `Content pack manifest exceeds ${CONTENT_PACK_MANIFEST_MAX_BYTES} bytes`,
      cause: { name: "ContentPackManifestTooLargeError" },
    });
  });
});
