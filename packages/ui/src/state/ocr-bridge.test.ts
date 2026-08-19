/**
 * Verifies the renderer OCR polling lifecycle and native recognition round-trip
 * with fake time, mocked HTTP, and a mocked Tesseract bridge.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initOcrBridge } from "./ocr-bridge";

const recognizeMock = vi.fn();
let stopBridge: () => void = () => {};

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
    stopBridge();
    stopBridge = () => {};
  });

  afterEach(() => {
    stopBridge();
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

    stopBridge = initOcrBridge();
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

    stopBridge = initOcrBridge();
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

  it("times out a poll that never returns response headers", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        }),
    );

    stopBridge = initOcrBridge();
    await vi.advanceTimersByTimeAsync(16_199);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(requestSignal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recognizeMock).not.toHaveBeenCalled();
  });

  it("keeps the poll deadline active while reading its JSON body", async () => {
    let requestSignal: AbortSignal | undefined;
    const json = vi.fn(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return { ok: true, json } as unknown as Response;
    });

    stopBridge = initOcrBridge();
    await vi.advanceTimersByTimeAsync(16_200);

    expect(json).toHaveBeenCalledTimes(1);
    expect(requestSignal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(recognizeMock).not.toHaveBeenCalled();
  });

  it("propagates caller cancellation and stops future poll ticks", async () => {
    const caller = new AbortController();
    const reason = new DOMException("Renderer stopped", "AbortError");
    const removeAbortListener = vi.spyOn(caller.signal, "removeEventListener");
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        }),
    );

    stopBridge = initOcrBridge(caller.signal);
    await vi.advanceTimersByTimeAsync(1200);
    caller.abort(reason);
    await vi.advanceTimersByTimeAsync(5000);

    expect(requestSignal?.reason).toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(removeAbortListener).toHaveBeenCalled();
    expect(recognizeMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the result deadline active while reading its response body", async () => {
    recognizeMock.mockResolvedValue({ words: [] });
    let postSignal: AbortSignal | undefined;
    const stalledBody = vi.fn(
      () =>
        new Promise<ArrayBuffer>((_resolve, reject) => {
          postSignal?.addEventListener(
            "abort",
            () => reject(postSignal?.reason),
            { once: true },
          );
        }),
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            requests: [{ requestId: "ocr-3", imageBase64: "abcd" }],
          }),
        ),
      )
      .mockImplementationOnce(async (_input, init) => {
        postSignal = init?.signal ?? undefined;
        return {
          ok: true,
          arrayBuffer: stalledBody,
        } as unknown as Response;
      })
      .mockResolvedValueOnce(new Response("reported"));

    stopBridge = initOcrBridge();
    await vi.advanceTimersByTimeAsync(16_200);

    expect(stalledBody).toHaveBeenCalledTimes(1);
    expect(postSignal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]?.body).toContain("timed out");
  });
});
