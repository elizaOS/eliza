/** Verifies ocr bridge through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * The renderer OCR bridge (`ocr-bridge`): its interval poll of the Tesseract
 * Capacitor plugin and the request/frame round-trip. jsdom with fake timers;
 * the Capacitor core and Tesseract plugin are mocked — no native OCR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetOcrBridgeForTests,
  OCR_REQUESTS_POLL_TIMEOUT_MS,
  OCR_RESULT_POST_TIMEOUT_MS,
  getOcrRequestsWithFetch,
  initOcrBridge,
  postOcrResultWithFetch,
} from "./ocr-bridge";

const recognizeMock = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "android",
  },
}));

vi.mock("../bridge/native-plugins", () => ({
  getTesseractPlugin: () => ({
    recognize: recognizeMock,
  }),
}));

describe("ocr bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    recognizeMock.mockReset();
    __resetOcrBridgeForTests();
  });

  afterEach(() => {
    __resetOcrBridgeForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("polls queued OCR requests and posts recognized words", async () => {
    const word = {
      text: "Save",
      left: 1,
      top: 2,
      width: 3,
      height: 4,
      confidence: 90,
      block: 1,
      par: 1,
      line: 1,
    };
    recognizeMock.mockResolvedValue({ words: [word] });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            requests: [{ requestId: "ocr-1", imageBase64: "abcd", psm: 11 }],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    initOcrBridge();
    await vi.advanceTimersByTimeAsync(1200);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/vision/ocr-requests",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(recognizeMock).toHaveBeenCalledWith({ image: "abcd", psm: 11 });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/vision/ocr-result",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "ocr-1",
          words: [word],
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("posts an error result when native recognition fails", async () => {
    recognizeMock.mockRejectedValue(new Error("missing traineddata"));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            requests: [{ requestId: "ocr-2", imageBase64: "abcd" }],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    initOcrBridge();
    await vi.advanceTimersByTimeAsync(1200);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/vision/ocr-result",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: "ocr-2",
          error: "missing traineddata",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected ocr-bridge abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("ocr-bridge poll GET deadline", () => {
  it("keeps a documented UI fetch budget", () => {
    expect(OCR_REQUESTS_POLL_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled ocr-requests GET at the injected deadline", async () => {
    await expect(
      getOcrRequestsWithFetch(stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed ocr-requests GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    const response = await getOcrRequestsWithFetch(fetchImpl, 1_000);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(503);
  });

  it("uses the injected fetch for a successful ocr-requests GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response(JSON.stringify({ requests: [] }), { status: 200 });
    };

    const response = await getOcrRequestsWithFetch(fetchImpl, 1_000);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ requests: [] });
  });
});

describe("ocr-bridge result POST deadline", () => {
  it("keeps a documented UI fetch budget", () => {
    expect(OCR_RESULT_POST_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled ocr-result POST at the injected deadline", async () => {
    await expect(
      postOcrResultWithFetch({ requestId: "ocr-1" }, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed ocr-result POST", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    await expect(
      postOcrResultWithFetch({ requestId: "ocr-1" }, fetchImpl, 1_000),
    ).rejects.toThrow("503");
  });

  it("uses the injected fetch for a successful ocr-result POST", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response("ok", { status: 200 });
    };

    const response = await postOcrResultWithFetch(
      { requestId: "ocr-1" },
      fetchImpl,
      1_000,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(response.ok).toBe(true);
  });
});
