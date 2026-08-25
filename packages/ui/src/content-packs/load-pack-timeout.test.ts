/** Exercises content-pack transport and body deadlines through the public URL loader. */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/shared", () => ({
  CONTENT_PACK_MANIFEST_FILENAME: "pack.json",
  validateContentPackManifest: () => [],
}));

import { ContentPackLoadError, loadContentPackFromUrl } from "./load-pack";

const BASE_URL = "https://example.com/packs/cyberpunk-neon/";
const MANIFEST_URL = `${BASE_URL}pack.json`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("content-pack manifest deadline", () => {
  it("keeps the 15-second deadline active while the response body stalls", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutController.signal);
    let bodyStarted = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(init.signal?.reason),
              { once: true },
            );
          },
          pull() {
            bodyStarted = true;
          },
        });
        return new Response(body);
      }) as typeof fetch,
    );

    const pending = loadContentPackFromUrl(BASE_URL);
    await vi.waitFor(() => expect(bodyStarted).toBe(true));
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    timeoutController.abort(new DOMException("timed out", "TimeoutError"));

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ContentPackLoadError);
    expect(error).toMatchObject({ cause: { name: "TimeoutError" } });
  });

  it("composes caller cancellation with the manifest deadline", async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        });
      }) as unknown as typeof fetch,
    );

    const pending = loadContentPackFromUrl(BASE_URL, { signal: caller.signal });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    caller.abort(new DOMException("unmounted", "AbortError"));

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ContentPackLoadError);
    expect(error).toMatchObject({ cause: { name: "AbortError" } });
  });

  it("consumes a successful manifest through the public loader", async () => {
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

    const pack = await loadContentPackFromUrl(BASE_URL);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(MANIFEST_URL);
    expect(pack.source).toEqual({ kind: "url", url: BASE_URL });
  });

  it("preserves provider errors at the structured loader boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response("nope", {
            status: 503,
            statusText: "Service Unavailable",
          }),
      ),
    );

    const error = await loadContentPackFromUrl(BASE_URL).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ContentPackLoadError);
    expect(error).toMatchObject({
      source: { kind: "url", url: BASE_URL },
    });
    expect((error as ContentPackLoadError).cause).toMatchObject({
      message: "HTTP 503 Service Unavailable",
    });
  });
});
