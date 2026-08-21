/**
 * Pins LinkedIn transport deadlines, bounded response reads, upload authority, and multipart
 * validation with deterministic mocked network and media boundaries.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

const originalFetch = globalThis.fetch;
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function loadProvider() {
  const { linkedinAdsProvider, linkedinFetch } = await import("./linkedin");
  return { provider: linkedinAdsProvider, linkedinFetch };
}

const credentials = { accessToken: "linkedin-token" };
const EMPTY_ERROR = "No LinkedIn ad accounts found or invalid credentials";

afterEach(() => {
  globalThis.fetch = originalFetch;
  downloadAdMedia.mockClear();
});

describe("linkedinAdsProvider.validateCredentials error policy", () => {
  test("a network/transport failure surfaces the real error, not the empty-list message", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network unreachable");
    }) as typeof fetch;

    const result = await (await loadProvider()).provider.validateCredentials(credentials);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("network unreachable");
    expect(result.error).not.toBe(EMPTY_ERROR);
  });

  test("a non-2xx LinkedIn response surfaces the API error, distinct from empty", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ message: "Invalid access token" }, 401),
    ) as typeof fetch;

    const result = await (await loadProvider()).provider.validateCredentials(credentials);

    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid access token");
    expect(result.error).not.toBe(EMPTY_ERROR);
  });

  test("a successful fetch with zero accounts is the distinct legitimately-empty result", async () => {
    globalThis.fetch = mock(async () => jsonResponse({ elements: [] })) as typeof fetch;

    const result = await (await loadProvider()).provider.validateCredentials(credentials);

    expect(result).toEqual({ valid: false, error: EMPTY_ERROR });
  });

  test("a successful fetch with an account validates without an error", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({
        elements: [{ id: 507404993, name: "Dunder Mifflin Account" }],
      }),
    ) as typeof fetch;

    const result = await (await loadProvider()).provider.validateCredentials(credentials);

    expect(result).toEqual({
      valid: true,
      accountId: "507404993",
      accountName: "Dunder Mifflin Account",
    });
  });
});

describe("linkedinFetch bounded lifecycle", () => {
  test("aborts a hung header fetch at the deadline", async () => {
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ) as typeof fetch;

    const start = Date.now();
    const { linkedinFetch } = await loadProvider();
    await expect(
      linkedinFetch("https://api.linkedin.com/rest/adAccountsV2", undefined, 50),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("keeps the deadline when a caller signal never aborts", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal;
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ) as typeof fetch;

    const controller = new AbortController();
    const { linkedinFetch } = await loadProvider();
    await expect(
      linkedinFetch(
        "https://api.linkedin.com/rest/adAccountsV2",
        { signal: controller.signal },
        50,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(seen).not.toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false);
  });

  test("caller cancellation wins without waiting for the deadline", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal;
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ) as typeof fetch;

    const controller = new AbortController();
    const callerReason = new DOMException("caller stopped", "AbortError");
    const { linkedinFetch } = await loadProvider();
    const pending = linkedinFetch(
      "https://api.linkedin.com/rest/adAccountsV2",
      { signal: controller.signal },
      10_000,
    );
    controller.abort(callerReason);

    await expect(pending).rejects.toBe(callerReason);
    expect(seen?.reason).toBe(callerReason);
  });

  test("bounds and cancels a response body that never completes", async () => {
    let cancelCount = 0;
    let originalResponse: Response | undefined;
    globalThis.fetch = mock(async () => {
      originalResponse = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
          cancel() {
            cancelCount += 1;
          },
        }),
      );
      return originalResponse;
    }) as typeof fetch;

    const { linkedinFetch } = await loadProvider();
    await expect(
      linkedinFetch("https://api.linkedin.com/rest/adAccountsV2", undefined, 50),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await Bun.sleep(0);
    expect(cancelCount).toBe(1);
    expect(originalResponse?.body?.locked).toBe(false);
  });

  test("rejects an oversized declared body and cancels it before acquiring a reader", async () => {
    let cancelCount = 0;
    let originalResponse: Response | undefined;
    globalThis.fetch = mock(async () => {
      originalResponse = new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelCount += 1;
          },
        }),
        { headers: { "content-length": String(1024 * 1024 + 1) } },
      );
      return originalResponse;
    }) as typeof fetch;

    const { linkedinFetch } = await loadProvider();
    await expect(
      linkedinFetch("https://api.linkedin.com/rest/adAccountsV2", undefined, 1_000),
    ).rejects.toMatchObject({ code: "LINKEDIN_RESPONSE_TOO_LARGE" });
    expect(cancelCount).toBe(1);
    expect(originalResponse?.body?.locked).toBe(false);
  });

  test("cancels a streamed body that exceeds the byte cap", async () => {
    let cancelCount = 0;
    let originalResponse: Response | undefined;
    globalThis.fetch = mock(async () => {
      originalResponse = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelCount += 1;
          },
        }),
      );
      return originalResponse;
    }) as typeof fetch;

    const { linkedinFetch } = await loadProvider();
    await expect(
      linkedinFetch("https://api.linkedin.com/rest/adAccountsV2", undefined, 1_000),
    ).rejects.toMatchObject({ code: "LINKEDIN_RESPONSE_TOO_LARGE" });
    expect(cancelCount).toBe(1);
    expect(originalResponse?.body?.locked).toBe(false);
  });

  test("clears deadline, caller listener, and response reader after success", async () => {
    let seen: AbortSignal | undefined;
    let originalResponse: Response | undefined;
    const caller = new AbortController();
    let callerAdds = 0;
    let callerRemoves = 0;
    const originalAdd = caller.signal.addEventListener.bind(caller.signal);
    const originalRemove = caller.signal.removeEventListener.bind(caller.signal);
    Object.defineProperty(caller.signal, "addEventListener", {
      value: ((...args: Parameters<AbortSignal["addEventListener"]>) => {
        callerAdds += 1;
        return originalAdd(...args);
      }) as AbortSignal["addEventListener"],
    });
    Object.defineProperty(caller.signal, "removeEventListener", {
      value: ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
        callerRemoves += 1;
        return originalRemove(...args);
      }) as AbortSignal["removeEventListener"],
    });
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      originalResponse = jsonResponse({ elements: [] });
      return originalResponse;
    }) as typeof fetch;

    const { linkedinFetch } = await loadProvider();
    const response = await linkedinFetch(
      "https://api.linkedin.com/rest/adAccountsV2",
      { signal: caller.signal },
      25,
    );
    expect(await response.json()).toEqual({ elements: [] });
    expect(originalResponse?.body?.locked).toBe(false);
    expect(callerAdds).toBe(1);
    expect(callerRemoves).toBe(1);
    await Bun.sleep(50);
    expect(seen?.aborted).toBe(false);
  });

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects invalid timeout %p before fetching",
    async (timeoutMs) => {
      const fetchMock = mock(async () => jsonResponse({}));
      globalThis.fetch = fetchMock as typeof fetch;
      const { linkedinFetch } = await loadProvider();
      await expect(
        linkedinFetch("https://api.linkedin.com/rest/adAccountsV2", undefined, timeoutMs),
      ).rejects.toMatchObject({ code: "INVALID_LINKEDIN_TIMEOUT" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

function uploadInitializationFetch(value: unknown) {
  return mock()
    .mockResolvedValueOnce(jsonResponse({ reference: "urn:li:organization:1" }))
    .mockResolvedValueOnce(jsonResponse({ value }));
}

async function uploadVideoWith(value: unknown) {
  const fetchMock = uploadInitializationFetch(value);
  globalThis.fetch = fetchMock as typeof fetch;
  const result = await (await loadProvider()).provider.uploadMedia(credentials, "1", {
    type: "video",
    url: "https://media.example.test/ad.mp4",
  });
  return { fetchMock, result };
}

describe("linkedinAdsProvider upload authority and work bounds", () => {
  test.each([
    "https://attacker.example/upload",
    "http://www.linkedin.com/dms-uploads/1",
    "https://linkedin.com.attacker.example/dms-uploads/1",
    "https://user@www.linkedin.com/dms-uploads/1",
  ])("rejects hostile image upload URL %s before forwarding bearer credentials", async (url) => {
    const fetchMock = uploadInitializationFetch({
      uploadUrl: url,
      image: "urn:li:image:1",
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await (await loadProvider()).provider.uploadMedia(credentials, "1", {
      type: "image",
      url: "https://media.example.test/ad.png",
    });

    expect(result).toMatchObject({ success: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("rejects a hostile video upload URL before the first PUT", async () => {
    const { fetchMock, result } = await uploadVideoWith({
      video: "urn:li:video:1",
      uploadInstructions: [
        {
          uploadUrl: "https://www.linkedin.com.attacker.example/upload",
          firstByte: 0,
          lastByte: 3,
        },
      ],
    });

    expect(result).toMatchObject({ success: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("refuses a same-origin image redirect before bearer and bytes can be replayed", async () => {
    const replayed: Array<{
      authorization: string | null;
      body: BodyInit | null | undefined;
    }> = [];
    const fetchMock = uploadInitializationFetch({
      uploadUrl: "https://www.linkedin.com/dms-uploads/1",
      image: "urn:li:image:1",
    }).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect === "error") {
        throw new TypeError("Fetch is configured to reject redirects");
      }
      replayed.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body,
      });
      return new Response(null, { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await (await loadProvider()).provider.uploadMedia(credentials, "1", {
      type: "image",
      url: "https://media.example.test/ad.png",
    });

    expect(result).toMatchObject({ success: false });
    expect(replayed).toEqual([]);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ redirect: "error" });
  });

  test("refuses a cross-origin video redirect before media bytes can be replayed", async () => {
    const replayed: Array<BodyInit | null | undefined> = [];
    const fetchMock = uploadInitializationFetch({
      video: "urn:li:video:1",
      uploadToken: "upload-token",
      uploadInstructions: [
        {
          uploadUrl: "https://www.linkedin.com/dms-uploads/1",
          firstByte: 0,
          lastByte: 3,
        },
      ],
    }).mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect === "error") {
        throw new TypeError("Fetch is configured to reject redirects");
      }
      replayed.push(init?.body);
      return new Response(null, {
        status: 200,
        headers: { etag: "leaked-part" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await (await loadProvider()).provider.uploadMedia(credentials, "1", {
      type: "video",
      url: "https://media.example.test/ad.mp4",
    });

    expect(result).toMatchObject({ success: false });
    expect(replayed).toEqual([]);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ redirect: "error" });
  });

  test.each([
    {
      name: "nonzero start",
      uploadInstructions: [
        {
          uploadUrl: "https://www.linkedin.com/dms-uploads/1",
          firstByte: 1,
          lastByte: 3,
        },
      ],
    },
    {
      name: "fractional boundary",
      uploadInstructions: [
        {
          uploadUrl: "https://www.linkedin.com/dms-uploads/1",
          firstByte: 0.5,
          lastByte: 3,
        },
      ],
    },
    {
      name: "out-of-bounds end",
      uploadInstructions: [
        {
          uploadUrl: "https://www.linkedin.com/dms-uploads/1",
          firstByte: 0,
          lastByte: 4,
        },
      ],
    },
    {
      name: "incomplete coverage",
      uploadInstructions: [
        {
          uploadUrl: "https://www.linkedin.com/dms-uploads/1",
          firstByte: 0,
          lastByte: 2,
        },
      ],
    },
    {
      name: "overlap",
      uploadInstructions: [
        {
          uploadUrl: "https://www.linkedin.com/dms-uploads/1",
          firstByte: 0,
          lastByte: 1,
        },
        {
          uploadUrl: "https://www.linkedin.com/dms-uploads/2",
          firstByte: 1,
          lastByte: 3,
        },
      ],
    },
    {
      name: "gap",
      uploadInstructions: [
        {
          uploadUrl: "https://www.linkedin.com/dms-uploads/1",
          firstByte: 0,
          lastByte: 0,
        },
        {
          uploadUrl: "https://www.linkedin.com/dms-uploads/2",
          firstByte: 2,
          lastByte: 3,
        },
      ],
    },
  ])("rejects invalid video byte ranges before any PUT: $name", async ({ uploadInstructions }) => {
    const { fetchMock, result } = await uploadVideoWith({
      video: "urn:li:video:1",
      uploadInstructions,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(
      /LinkedIn returned invalid video upload byte ranges|LinkedIn video upload instructions do not cover the file/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("caps video instructions before validating or dispatching any PUT", async () => {
    const uploadInstructions = Array.from({ length: 17 }, (_, index) => ({
      uploadUrl: `https://www.linkedin.com/dms-uploads/${index}`,
      firstByte: index,
      lastByte: index,
    }));
    const { fetchMock, result } = await uploadVideoWith({
      video: "urn:li:video:1",
      uploadInstructions,
    });

    expect(result).toEqual({
      success: false,
      error: "LinkedIn returned an invalid video upload part count",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("uploads validated parts in order without OAuth bearer, then finalizes in ETag order", async () => {
    const fetchMock = uploadInitializationFetch({
      video: "urn:li:video:1",
      uploadToken: "upload-token",
      uploadInstructions: [
        {
          uploadUrl: "https://www.linkedin.com/dms-uploads/1",
          firstByte: 0,
          lastByte: 1,
        },
        {
          uploadUrl: "https://media.licdn.com/dms-uploads/2",
          firstByte: 2,
          lastByte: 3,
        },
      ],
    })
      .mockResolvedValueOnce(new Response(null, { headers: { etag: "part-1" } }))
      .mockResolvedValueOnce(new Response(null, { headers: { etag: "part-2" } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await (await loadProvider()).provider.uploadMedia(credentials, "1", {
      type: "video",
      url: "https://media.example.test/ad.mp4",
    });

    expect(result).toMatchObject({ success: true, metadata: { parts: 2 } });
    const firstPut = fetchMock.mock.calls[2];
    const secondPut = fetchMock.mock.calls[3];
    const finalizeCall = fetchMock.mock.calls[4];
    if (!firstPut || !secondPut || !finalizeCall) {
      throw new Error("Expected initialization, two part uploads, and finalization");
    }
    expect(firstPut[0]).toBe("https://www.linkedin.com/dms-uploads/1");
    expect(secondPut[0]).toBe("https://media.licdn.com/dms-uploads/2");
    expect(new Uint8Array((firstPut[1] as RequestInit).body as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2]),
    );
    expect(new Uint8Array((secondPut[1] as RequestInit).body as ArrayBuffer)).toEqual(
      new Uint8Array([3, 4]),
    );
    for (const call of [firstPut, secondPut]) {
      expect(call[1]).toMatchObject({ redirect: "error" });
      const headers = new Headers((call[1] as RequestInit | undefined)?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.get("content-type")).toBe("application/octet-stream");
    }
    expect(new Headers((finalizeCall[1] as RequestInit).headers).get("authorization")).toBe(
      "Bearer linkedin-token",
    );
    expect(JSON.parse(String((finalizeCall[1] as RequestInit).body))).toEqual({
      finalizeUploadRequest: {
        video: "urn:li:video:1",
        uploadToken: "upload-token",
        uploadedPartIds: ["part-1", "part-2"],
      },
    });
  });
});
