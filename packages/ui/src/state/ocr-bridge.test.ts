// @vitest-environment jsdom

/**
 * The renderer OCR bridge (`ocr-bridge`): its interval poll of the Tesseract
 * Capacitor plugin and the request/frame round-trip. jsdom with fake timers;
 * the Capacitor core and Tesseract plugin are mocked — no native OCR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetOcrBridgeForTests, initOcrBridge } from "./ocr-bridge";

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

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/vision/ocr-requests");
    expect(recognizeMock).toHaveBeenCalledWith({ image: "abcd", psm: 11 });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/vision/ocr-result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "ocr-1",
        words: [word],
      }),
    });
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

    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/vision/ocr-result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "ocr-2",
        error: "missing traineddata",
      }),
    });
  });
});
