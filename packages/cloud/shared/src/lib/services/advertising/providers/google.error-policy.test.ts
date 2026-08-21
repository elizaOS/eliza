/**
 * Pins Google Ads failure distinctness, bounded transport/body lifecycle, account-fanout
 * validation, and resumable-upload authority with deterministic mocked network/media boundaries.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

mock.module("../../../utils/logger", () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}));

const downloadAdMedia = mock(async () => ({
  url: "https://media.example.test/ad.mp4",
  bytes: new Uint8Array([1, 2, 3, 4]),
  base64: "AQIDBA==",
  contentType: "video/mp4",
  fileName: "ad.mp4",
}));

mock.module("../media-utils", () => ({
  downloadAdMedia,
  mediaFileName: () => "ad.mp4",
}));

const { googleAdsProvider, googleAdsFetch } = await import("./google");

const originalFetch = globalThis.fetch;
const credentials = { accessToken: "token" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Route mocked fetch by URL: listAccessibleCustomers vs. searchStream (googleAdsRequest).
function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  downloadAdMedia.mockClear();
});

describe("googleAdsProvider.listAdAccounts error surfacing", () => {
  test("resolves an empty array for valid credentials with no accessible customers", async () => {
    mockFetch((url) => {
      if (url.includes("listAccessibleCustomers")) {
        return jsonResponse({ resourceNames: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(googleAdsProvider.listAdAccounts(credentials)).resolves.toEqual([]);
  });

  test("propagates a transport failure on the accessible-customers fetch", async () => {
    mockFetch((url) => {
      if (url.includes("listAccessibleCustomers")) {
        throw new Error("network down");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(googleAdsProvider.listAdAccounts(credentials)).rejects.toThrow("network down");
  });

  test("propagates a failed per-customer detail fetch instead of silently dropping the account", async () => {
    mockFetch((url) => {
      if (url.includes("listAccessibleCustomers")) {
        return jsonResponse({ resourceNames: ["customers/123"] });
      }
      // searchStream for the customer detail returns a Google Ads API error.
      return jsonResponse(
        { error: { code: 7, message: "USER_PERMISSION_DENIED", status: "PERMISSION_DENIED" } },
        403,
      );
    });

    await expect(googleAdsProvider.listAdAccounts(credentials)).rejects.toThrow(
      "USER_PERMISSION_DENIED",
    );
  });

  test("returns the populated account list when every fetch succeeds", async () => {
    mockFetch((url) => {
      if (url.includes("listAccessibleCustomers")) {
        return jsonResponse({ resourceNames: ["customers/123"] });
      }
      return jsonResponse({
        results: [
          { customer: { resourceName: "customers/123", id: "123", descriptiveName: "Acme" } },
        ],
      });
    });

    await expect(googleAdsProvider.listAdAccounts(credentials)).resolves.toEqual([
      { id: "123", name: "Acme" },
    ]);
  });

  test("rejects an oversized accessible-customer set before detail fanout", async () => {
    let fetches = 0;
    mockFetch((url) => {
      fetches += 1;
      if (url.includes("listAccessibleCustomers")) {
        return jsonResponse({
          resourceNames: Array.from({ length: 10_001 }, (_, index) => `customers/${index + 1}`),
        });
      }
      throw new Error(`unexpected detail fetch: ${url}`);
    });

    await expect(googleAdsProvider.listAdAccounts(credentials)).rejects.toThrow(
      /more than 10000 accessible customers/,
    );
    expect(fetches).toBe(1);
  });

  test.each([
    { name: "non-array", resourceNames: "customers/123" },
    { name: "non-string", resourceNames: [123] },
    { name: "wrong prefix", resourceNames: ["accounts/123"] },
    { name: "empty id", resourceNames: ["customers/"] },
    { name: "non-numeric id", resourceNames: ["customers/abc"] },
    { name: "duplicate", resourceNames: ["customers/123", "customers/123"] },
  ])(
    "rejects $name accessible-customer resources before detail fanout",
    async ({ resourceNames }) => {
      let fetches = 0;
      mockFetch((url) => {
        fetches += 1;
        if (url.includes("listAccessibleCustomers")) {
          return jsonResponse({ resourceNames });
        }
        throw new Error(`unexpected detail fetch: ${url}`);
      });

      await expect(googleAdsProvider.listAdAccounts(credentials)).rejects.toThrow(
        /malformed|invalid resource|duplicate resource/,
      );
      expect(fetches).toBe(1);
    },
  );

  test("enforces one overall deadline across accessible-customer detail fanout", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const shortenedTimers = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) =>
      originalSetTimeout(callback, delay === 60_000 ? 20 : delay, ...args)) as typeof setTimeout);
    let detailSignal: AbortSignal | undefined;
    const fetchMock = mock()
      .mockResolvedValueOnce(jsonResponse({ resourceNames: ["customers/123"] }))
      .mockImplementation(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            detailSignal = init?.signal ?? undefined;
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(googleAdsProvider.listAdAccounts(credentials)).rejects.toMatchObject({
        name: "TimeoutError",
      });
      expect(detailSignal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      shortenedTimers.mockRestore();
    }
  });
});

describe("googleAdsProvider.getCampaignMetrics money-path distinctness", () => {
  // money-path-flagged: the spend arithmetic and the zeroed empty-metrics fallback are
  // left UNCHANGED. This only pins that a failed metrics fetch surfaces and stays distinct
  // from a legitimately-empty (no rows in range) success — without asserting a computed value.
  test("propagates a failed metrics fetch instead of reporting empty spend", async () => {
    mockFetch(() =>
      jsonResponse(
        { error: { code: 3, message: "INVALID_QUERY", status: "INVALID_ARGUMENT" } },
        400,
      ),
    );

    await expect(googleAdsProvider.getCampaignMetrics(credentials, "123/456")).rejects.toThrow(
      "INVALID_QUERY",
    );
  });

  test("reports success with zeroed metrics for a campaign with no rows in range", async () => {
    mockFetch(() => jsonResponse({ results: [] }));

    const result = await googleAdsProvider.getCampaignMetrics(credentials, "123/456");

    expect(result).toEqual({
      success: true,
      metrics: { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
    });
  });
});

describe("googleAdsFetch — bounded hops fail closed and keep caller signals", () => {
  test("aborts a hung Google Ads API hop at the timeout", async () => {
    // An API that never settles on its own: the only way out is the caller's
    // AbortSignal firing (the 30s default bounds every ads / upload hop).
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as unknown as typeof fetch;

    const start = Date.now();
    await expect(
      googleAdsFetch(
        "https://googleads.googleapis.com/v24/customers:listAccessibleCustomers",
        undefined,
        100,
      ),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("composes caller cancellation with the hop deadline", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener("abort", () => reject(seen?.reason), { once: true });
        }),
    ) as unknown as typeof fetch;

    const controller = new AbortController();
    const pending = googleAdsFetch(
      "https://googleads.googleapis.com/v24/customers:listAccessibleCustomers",
      { signal: controller.signal },
    );
    await Promise.resolve();
    expect(seen).not.toBe(controller.signal);
    controller.abort(new Error("caller cancelled"));
    await expect(pending).rejects.toThrow(/caller cancelled/);
    expect(seen?.aborted).toBe(true);
  });

  test("keeps the deadline when a supplied caller signal never aborts", async () => {
    const controller = new AbortController();
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    ) as unknown as typeof fetch;

    await expect(
      googleAdsFetch(
        "https://googleads.googleapis.com/v24/customers:listAccessibleCustomers",
        { signal: controller.signal },
        100,
      ),
    ).rejects.toThrow(/timed out/i);
    expect(controller.signal.aborted).toBe(false);
  });

  test("bounds and cancels a response body that never completes", async () => {
    let cancelCount = 0;
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
            cancel() {
              cancelCount += 1;
            },
          }),
        ),
    ) as unknown as typeof fetch;

    await expect(
      googleAdsFetch(
        "https://googleads.googleapis.com/v24/customers:listAccessibleCustomers",
        undefined,
        50,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await Bun.sleep(0);
    expect(cancelCount).toBe(1);
  });

  test("rejects and cancels an oversized declared response body", async () => {
    let cancelCount = 0;
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelCount += 1;
            },
          }),
          { headers: { "content-length": String(4 * 1024 * 1024 + 1) } },
        ),
    ) as unknown as typeof fetch;

    await expect(
      googleAdsFetch("https://googleads.googleapis.com/v24/customers:listAccessibleCustomers"),
    ).rejects.toMatchObject({ code: "GOOGLE_ADS_RESPONSE_TOO_LARGE" });
    expect(cancelCount).toBe(1);
  });

  test("clears its timer and caller listener after a successful bounded body read", async () => {
    const controller = new AbortController();
    const addListener = spyOn(controller.signal, "addEventListener");
    const removeListener = spyOn(controller.signal, "removeEventListener");
    const clearTimer = spyOn(globalThis, "clearTimeout");
    globalThis.fetch = mock(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;

    const response = await googleAdsFetch(
      "https://googleads.googleapis.com/v24/customers:listAccessibleCustomers",
      { signal: controller.signal },
      1_000,
    );

    expect(await response.json()).toEqual({ ok: true });
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(clearTimer).toHaveBeenCalledTimes(1);
    addListener.mockRestore();
    removeListener.mockRestore();
    clearTimer.mockRestore();
  });

  test("clears its timer and caller listener after a transport failure", async () => {
    const controller = new AbortController();
    const removeListener = spyOn(controller.signal, "removeEventListener");
    const clearTimer = spyOn(globalThis, "clearTimeout");
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    try {
      await expect(
        googleAdsFetch(
          "https://googleads.googleapis.com/v24/customers:listAccessibleCustomers",
          { signal: controller.signal },
          1_000,
        ),
      ).rejects.toThrow("network down");
      expect(removeListener).toHaveBeenCalledTimes(1);
      expect(clearTimer).toHaveBeenCalledTimes(1);
    } finally {
      removeListener.mockRestore();
      clearTimer.mockRestore();
    }
  });

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects invalid timeout %p before fetching",
    async (timeoutMs) => {
      const fetchMock = mock(async () => jsonResponse({}));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        googleAdsFetch(
          "https://googleads.googleapis.com/v24/customers:listAccessibleCustomers",
          undefined,
          timeoutMs,
        ),
      ).rejects.toMatchObject({ code: "INVALID_GOOGLE_ADS_TIMEOUT" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

function videoUploadInput() {
  return {
    type: "video" as const,
    url: "https://media.example.test/ad.mp4",
    name: "Campaign video",
  };
}

function uploadStartResponse(uploadUrl: string): Response {
  return new Response(null, { headers: { "x-goog-upload-url": uploadUrl } });
}

async function uploadVideo() {
  const uploadMedia = googleAdsProvider.uploadMedia;
  if (!uploadMedia) throw new Error("Google Ads provider does not expose media upload");
  return uploadMedia(credentials, "123", videoUploadInput());
}

describe("googleAdsProvider resumable upload authority and lifecycle", () => {
  test.each([
    "https://attacker.example/upload",
    "http://googleads.googleapis.com/upload",
    "https://googleads.googleapis.com.attacker.example/upload",
    "https://user@googleads.googleapis.com/upload",
    "https://googleads.googleapis.com:444/upload",
    "https://googleads.googleapis.com/upload#fragment",
  ])(
    "rejects untrusted upload URL %s before forwarding credentials or bytes",
    async (uploadUrl) => {
      const fetchMock = mock().mockResolvedValueOnce(uploadStartResponse(uploadUrl));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await uploadVideo();

      expect(result).toMatchObject({ success: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  test("refuses upload redirects before bearer credentials or media bytes can be replayed", async () => {
    const replayed: Array<{ authorization: string | null; body: BodyInit | null | undefined }> = [];
    const fetchMock = mock()
      .mockResolvedValueOnce(
        uploadStartResponse("https://googleads.googleapis.com/resumable/upload/v24/session"),
      )
      .mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.redirect === "error") {
          throw new TypeError("Fetch is configured to reject redirects");
        }
        replayed.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: init?.body,
        });
        return jsonResponse({ resourceName: "customers/123/assets/456" });
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await uploadVideo();

    expect(result).toMatchObject({ success: false });
    expect(replayed).toEqual([]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ redirect: "error" });
  });

  test("aborts a hung finalize transport with the shared operation deadline", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const shortenedTimers = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) =>
      originalSetTimeout(callback, delay === 60_000 ? 20 : delay, ...args)) as typeof setTimeout);
    let finalizeSignal: AbortSignal | undefined;
    const fetchMock = mock()
      .mockResolvedValueOnce(
        uploadStartResponse("https://googleads.googleapis.com/resumable/upload/v24/session"),
      )
      .mockImplementation(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            finalizeSignal = init?.signal ?? undefined;
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await uploadVideo();
      expect(result).toMatchObject({ success: false });
      expect(result.error).toMatch(/video upload timed out/i);
      expect(finalizeSignal?.aborted).toBe(true);
    } finally {
      shortenedTimers.mockRestore();
    }
  });

  test("aborts and cancels a hung finalize response body with the shared deadline", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const shortenedTimers = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) =>
      originalSetTimeout(callback, delay === 60_000 ? 20 : delay, ...args)) as typeof setTimeout);
    let finalizeSignal: AbortSignal | undefined;
    let cancelCount = 0;
    const fetchMock = mock()
      .mockResolvedValueOnce(
        uploadStartResponse("https://googleads.googleapis.com/resumable/upload/v24/session"),
      )
      .mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        finalizeSignal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
            cancel() {
              cancelCount += 1;
            },
          }),
        );
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await uploadVideo();
      expect(result).toMatchObject({ success: false });
      expect(result.error).toMatch(/video upload timed out/i);
      expect(finalizeSignal?.aborted).toBe(true);
      expect(cancelCount).toBe(1);
    } finally {
      shortenedTimers.mockRestore();
    }
  });

  test("clears the shared operation timer after a successful direct upload", async () => {
    const setTimer = spyOn(globalThis, "setTimeout");
    const clearTimer = spyOn(globalThis, "clearTimeout");
    const fetchMock = mock()
      .mockResolvedValueOnce(
        uploadStartResponse("https://googleads.googleapis.com/resumable/upload/v24/session"),
      )
      .mockResolvedValueOnce(jsonResponse({ resourceName: "customers/123/assets/456" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const result = await uploadVideo();
      expect(result).toMatchObject({
        success: true,
        providerAssetId: "customers/123/assets/456",
      });
      const finalizeCall = fetchMock.mock.calls[1];
      if (!finalizeCall) throw new Error("Expected a finalize upload request");
      const finalizeInit = finalizeCall[1] as RequestInit;
      expect(finalizeInit).toMatchObject({ redirect: "error" });
      expect(new Headers(finalizeInit.headers).get("authorization")).toBe("Bearer token");
      expect(new Uint8Array(finalizeInit.body as ArrayBuffer)).toEqual(
        new Uint8Array([1, 2, 3, 4]),
      );
      expect(setTimer).toHaveBeenCalledTimes(3);
      expect(clearTimer).toHaveBeenCalledTimes(3);
    } finally {
      setTimer.mockRestore();
      clearTimer.mockRestore();
    }
  });
});
