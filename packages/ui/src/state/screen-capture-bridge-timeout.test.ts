/**
 * Verifies screen-capture deadlines through the canonical ElizaClient and its
 * native-agent transport context rather than a signal-aware fetch test double.
 */
import { describe, expect, it, vi } from "vitest";
import { createAndroidNativeAgentTransport } from "../api/android-native-agent-transport";
import { ElizaClient } from "../api/client-base";
import {
  getCaptureRequestsWithClient,
  postScreenFrameWithClient,
  SCREEN_CAPTURE_POLL_TIMEOUT_MS,
  SCREEN_FRAME_POST_TIMEOUT_MS,
} from "./screen-capture-bridge";

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

describe("screen-capture native transport deadlines", () => {
  it("keeps documented independent budgets", () => {
    expect(SCREEN_CAPTURE_POLL_TIMEOUT_MS).toBe(15_000);
    expect(SCREEN_FRAME_POST_TIMEOUT_MS).toBe(15_000);
  });

  it("forwards the capture-request deadline to the native request", async () => {
    const request = vi.fn(async (options: NativeRequestOptions) => {
      throw new Error(`native timeout ${options.timeoutMs}`);
    });
    const apiClient = clientWithNativeRequest(request);

    await expect(getCaptureRequestsWithClient(apiClient, 3210)).rejects.toThrow(
      "native timeout 3210",
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/vision/capture-requests",
        timeoutMs: 3210,
      }),
    );
  });

  it("forwards the screen-frame deadline and JSON body to native", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    }));
    const apiClient = clientWithNativeRequest(request);

    await postScreenFrameWithClient(
      { requestId: "r1", base64: "frame" },
      apiClient,
      4321,
    );

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/vision/screen-frame",
        timeoutMs: 4321,
        body: JSON.stringify({ requestId: "r1", base64: "frame" }),
      }),
    );
  });

  it("parses successful capture requests through the client", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ requestId: "r1" }] }),
    }));

    await expect(
      getCaptureRequestsWithClient(clientWithNativeRequest(request), 5000),
    ).resolves.toEqual({ requests: [{ requestId: "r1" }] });
  });

  it("surfaces non-ok screen-frame responses", async () => {
    const request = vi.fn(async () => ({
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "unavailable" }),
    }));

    await expect(
      postScreenFrameWithClient(
        { requestId: "r1" },
        clientWithNativeRequest(request),
        5000,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});
