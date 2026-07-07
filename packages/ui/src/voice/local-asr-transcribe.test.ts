// @vitest-environment jsdom

// Verifies the cloud STT client leg: the WAV → `/api/asr/cloud` POST payload
// shape and the fail-loud contract. `fetchWithCsrf` + `resolveApiUrl` are
// stubbed so the assertions run against the request the helper builds, not a
// live server.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithCsrf } from "../api/csrf-client";
import { resolveApiUrl } from "../utils";
import { transcribeCloudWav } from "./local-asr-transcribe";

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(),
}));

vi.mock("../utils", () => ({
  resolveApiUrl: vi.fn((path: string) => `http://agent.local${path}`),
}));

const fetchWithCsrfMock = vi.mocked(fetchWithCsrf);
const resolveApiUrlMock = vi.mocked(resolveApiUrl);

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("transcribeCloudWav", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("POSTs the raw WAV bytes to /api/asr/cloud and returns the transcript", async () => {
    fetchWithCsrfMock.mockResolvedValue(
      jsonResponse({ text: "  hello world " }),
    );
    const wav = new Uint8Array([82, 73, 70, 70]); // "RIFF"

    const text = await transcribeCloudWav(wav);

    expect(resolveApiUrlMock).toHaveBeenCalledWith("/api/asr/cloud");
    const [url, init] = fetchWithCsrfMock.mock.calls[0] ?? [];
    expect(url).toBe("http://agent.local/api/asr/cloud");
    expect(init?.method).toBe("POST");
    // The WAV is sent as raw audio bytes (Content-Type audio/wav), NOT base64
    // JSON — the proxy reads the raw body and re-wraps it as multipart.
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "audio/wav",
    );
    expect(init?.body).toBe(wav);
    // Transcript is trimmed.
    expect(text).toBe("hello world");
  });

  it("throws on a non-2xx response (fail-loud, no silent empty result)", async () => {
    fetchWithCsrfMock.mockResolvedValue(
      jsonResponse({ error: "no api key" }, false, 401),
    );
    await expect(transcribeCloudWav(new Uint8Array([1]))).rejects.toThrow(
      /Cloud ASR 401/,
    );
  });

  it("throws on an empty transcript rather than returning ''", async () => {
    fetchWithCsrfMock.mockResolvedValue(jsonResponse({ text: "   " }));
    await expect(transcribeCloudWav(new Uint8Array([1]))).rejects.toThrow(
      /empty transcript/,
    );
  });

  it("passes an AbortSignal to fetch that aborts when the caller's signal aborts (#voice-V4)", async () => {
    // V4 composes the caller's signal with a per-attempt timeout controller, so
    // fetch no longer receives the caller's signal by identity — it receives the
    // internal controller's signal. The contract that matters: a caller abort
    // still aborts the in-flight fetch (the signal fetch actually saw).
    let sawSignal: AbortSignal | undefined;
    fetchWithCsrfMock.mockImplementation((_url, init) => {
      sawSignal = (init as RequestInit | undefined)?.signal ?? undefined;
      // Never resolve — hold the request open so we can observe the abort chain.
      return new Promise<Response>((_resolve, reject) => {
        sawSignal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    const controller = new AbortController();
    const p = transcribeCloudWav(new Uint8Array([1]), {
      signal: controller.signal,
    });
    // Let the fetch mock run and capture the signal it received.
    await Promise.resolve();
    expect(sawSignal).toBeInstanceOf(AbortSignal);
    expect(sawSignal?.aborted).toBe(false);
    // The caller aborts mid-flight → the signal fetch saw is aborted too.
    controller.abort();
    expect(sawSignal?.aborted).toBe(true);
    await expect(p).rejects.toThrow(/cancelled/);
  });

  it("aborts the fetch when its client-side timeout elapses (#voice-V4)", async () => {
    vi.useFakeTimers();
    try {
      let sawSignal: AbortSignal | undefined;
      // A fetch that never resolves until aborted, so the timeout is what ends it.
      fetchWithCsrfMock.mockImplementation((_url, init) => {
        sawSignal = (init as RequestInit | undefined)?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          sawSignal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      });
      // Only ONE attempt (retryable timeout) => expect exactly 2 fetch calls
      // (initial + single retry), then a timeout error surfaces.
      const p = transcribeCloudWav(new Uint8Array([1]), { timeoutMs: 15_000 });
      const assertion = expect(p).rejects.toThrow(/timed out after 15000ms/);
      // First attempt times out …
      await vi.advanceTimersByTimeAsync(15_000);
      // … retry fires, times out too.
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(fetchWithCsrfMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-retries ONCE on a network-class failure then succeeds (#voice-V4)", async () => {
    fetchWithCsrfMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse({ text: "second try" }));
    const text = await transcribeCloudWav(new Uint8Array([1]));
    expect(text).toBe("second try");
    expect(fetchWithCsrfMock).toHaveBeenCalledTimes(2);
  });

  it("retries once on a 5xx then surfaces the error if it persists (#voice-V4)", async () => {
    fetchWithCsrfMock.mockResolvedValue(
      jsonResponse({ error: "upstream" }, false, 502),
    );
    await expect(transcribeCloudWav(new Uint8Array([1]))).rejects.toThrow(
      /Cloud ASR 502/,
    );
    // initial + one retry (502 is retryable) — no third attempt.
    expect(fetchWithCsrfMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a terminal 4xx client error (#voice-V4)", async () => {
    fetchWithCsrfMock.mockResolvedValue(
      jsonResponse({ error: "no api key" }, false, 401),
    );
    await expect(transcribeCloudWav(new Uint8Array([1]))).rejects.toThrow(
      /Cloud ASR 401/,
    );
    // 401 is terminal — a single attempt, no retry.
    expect(fetchWithCsrfMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry an empty transcript (terminal) (#voice-V4)", async () => {
    fetchWithCsrfMock.mockResolvedValue(jsonResponse({ text: "   " }));
    await expect(transcribeCloudWav(new Uint8Array([1]))).rejects.toThrow(
      /empty transcript/,
    );
    expect(fetchWithCsrfMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry when the caller aborts (terminal) (#voice-V4)", async () => {
    const controller = new AbortController();
    fetchWithCsrfMock.mockImplementation((_url, init) => {
      const s = (init as RequestInit | undefined)?.signal;
      return new Promise<Response>((_resolve, reject) => {
        s?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    const p = transcribeCloudWav(new Uint8Array([1]), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(p).rejects.toThrow(/cancelled/);
    expect(fetchWithCsrfMock).toHaveBeenCalledTimes(1);
  });
});
