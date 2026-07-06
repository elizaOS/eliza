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
    fetchWithCsrfMock.mockResolvedValue(jsonResponse({ text: "  hello world " }));
    const wav = new Uint8Array([82, 73, 70, 70]); // "RIFF"

    const text = await transcribeCloudWav(wav);

    expect(resolveApiUrlMock).toHaveBeenCalledWith("/api/asr/cloud");
    const [url, init] = fetchWithCsrfMock.mock.calls[0] ?? [];
    expect(url).toBe("http://agent.local/api/asr/cloud");
    expect(init?.method).toBe("POST");
    // The WAV is sent as raw audio bytes (Content-Type audio/wav), NOT base64
    // JSON — the proxy reads the raw body and re-wraps it as multipart.
    expect(
      (init?.headers as Record<string, string>)["Content-Type"],
    ).toBe("audio/wav");
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

  it("forwards an abort signal to fetch", async () => {
    fetchWithCsrfMock.mockResolvedValue(jsonResponse({ text: "ok" }));
    const controller = new AbortController();
    await transcribeCloudWav(new Uint8Array([1]), {
      signal: controller.signal,
    });
    const [, init] = fetchWithCsrfMock.mock.calls[0] ?? [];
    expect(init?.signal).toBe(controller.signal);
  });
});
