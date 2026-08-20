/**
 * Exercises remote content-pack loading through mocked Fetch boundaries,
 * including caller cancellation and a deadline that remains active while the
 * response body is consumed.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/shared", () => ({
  CONTENT_PACK_MANIFEST_FILENAME: "pack.json",
  validateContentPackManifest: (value: unknown) =>
    value && typeof value === "object"
      ? []
      : [{ field: "root", message: "invalid" }],
}));

import { ContentPackLoadError, loadContentPackFromUrl } from "./load-pack";

const MANIFEST = {
  id: "cyberpunk-neon",
  name: "Cyberpunk Neon",
  version: "1.0.0",
  assets: {},
};

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
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              markBodyStarted();
              init?.signal?.addEventListener(
                "abort",
                () => reject(init.signal?.reason),
                { once: true },
              );
            }),
        }) as Response,
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
});
