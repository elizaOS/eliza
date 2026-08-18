/**
 * Verifies the native OCR poll/result round trip and its deadlines through the
 * canonical client transport rather than a signal-aware fetch test double.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAndroidNativeAgentTransport } from "../api/android-native-agent-transport";
import { ElizaClient } from "../api/client-base";
import {
  __resetOcrBridgeForTests,
  getOcrRequestsWithClient,
  initOcrBridge,
  OCR_REQUESTS_POLL_TIMEOUT_MS,
  OCR_RESULT_POST_TIMEOUT_MS,
  postOcrResultWithClient,
} from "./ocr-bridge";

const clientFetchMock = vi.hoisted(() => vi.fn());
const recognizeMock = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "android" },
}));
vi.mock("../api", () => ({
  client: { fetch: clientFetchMock },
}));
vi.mock("../bridge/native-plugins", () => ({
  getTesseractPlugin: () => ({ recognize: recognizeMock }),
}));

describe("OCR bridge poll and result round trip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clientFetchMock.mockReset();
    recognizeMock.mockReset();
    __resetOcrBridgeForTests();
  });

  afterEach(() => {
    __resetOcrBridgeForTests();
    vi.useRealTimers();
  });

  it("polls queued requests and posts recognized words", async () => {
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
    clientFetchMock
      .mockResolvedValueOnce({
        requests: [{ requestId: "ocr-1", imageBase64: "abcd", psm: 11 }],
      })
      .mockResolvedValueOnce({ ok: true });

    initOcrBridge();
    await vi.advanceTimersByTimeAsync(1200);

    expect(clientFetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/vision/ocr-requests",
      undefined,
      { timeoutMs: OCR_REQUESTS_POLL_TIMEOUT_MS },
    );
    expect(recognizeMock).toHaveBeenCalledWith({ image: "abcd", psm: 11 });
    expect(clientFetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/vision/ocr-result",
      {
        method: "POST",
        body: JSON.stringify({ requestId: "ocr-1", words: [word] }),
      },
      { timeoutMs: OCR_RESULT_POST_TIMEOUT_MS },
    );
  });

  it("posts an error result when native recognition fails", async () => {
    recognizeMock.mockRejectedValue(new Error("missing traineddata"));
    clientFetchMock
      .mockResolvedValueOnce({
        requests: [{ requestId: "ocr-2", imageBase64: "abcd" }],
      })
      .mockResolvedValueOnce({ ok: true });

    initOcrBridge();
    await vi.advanceTimersByTimeAsync(1200);

    expect(clientFetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/vision/ocr-result",
      {
        method: "POST",
        body: JSON.stringify({
          requestId: "ocr-2",
          error: "missing traineddata",
        }),
      },
      { timeoutMs: OCR_RESULT_POST_TIMEOUT_MS },
    );
  });
});

interface NativeRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}

interface NativeRequestResult {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

function clientWithNativeRequest(
  request: (options: NativeRequestOptions) => Promise<NativeRequestResult>,
): ElizaClient {
  const apiClient = new ElizaClient("eliza-local-agent://ipc", "token");
  apiClient.setRequestTransport(createAndroidNativeAgentTransport({ request }));
  return apiClient;
}

describe("OCR bridge native transport deadlines", () => {
  it("keeps documented independent budgets", () => {
    expect(OCR_REQUESTS_POLL_TIMEOUT_MS).toBe(15_000);
    expect(OCR_RESULT_POST_TIMEOUT_MS).toBe(15_000);
  });

  it("forwards the poll deadline into the native request", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [] }),
    }));

    await expect(
      getOcrRequestsWithClient(clientWithNativeRequest(request), 3210),
    ).resolves.toEqual({ requests: [] });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/vision/ocr-requests",
        timeoutMs: 3210,
      }),
    );
  });

  it("forwards the result deadline and JSON body into native", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    }));

    await postOcrResultWithClient(
      { requestId: "ocr-1", words: [] },
      clientWithNativeRequest(request),
      4321,
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/vision/ocr-result",
        timeoutMs: 4321,
        body: JSON.stringify({ requestId: "ocr-1", words: [] }),
      }),
    );
  });

  it("surfaces non-ok result responses", async () => {
    const request = vi.fn(async () => ({
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "unavailable" }),
    }));

    await expect(
      postOcrResultWithClient(
        { requestId: "ocr-1" },
        clientWithNativeRequest(request),
        5000,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});
