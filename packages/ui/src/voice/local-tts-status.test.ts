// @vitest-environment jsdom

// Verifies the on-device Kokoro TTS readiness probe: it hits
// `/api/tts/local-inference/status`, treats `{ ready: true }` as ready, and
// fails CLOSED (unknown readiness → not ready) on non-2xx, non-JSON, or a
// thrown fetch. `fetchWithCsrf` + `resolveApiUrl` are stubbed so assertions run
// against the request the helper builds, not a live server.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithCsrf } from "../api/csrf-client";
import { resolveApiUrl } from "../utils";
import { isLocalInferenceTtsReady } from "./local-tts-status";

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(),
}));

vi.mock("../utils", () => ({
  resolveApiUrl: vi.fn((path: string) => `http://agent.local${path}`),
}));

const fetchWithCsrfMock = vi.mocked(fetchWithCsrf);

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  fetchWithCsrfMock.mockReset();
  vi.mocked(resolveApiUrl).mockClear();
});

describe("isLocalInferenceTtsReady", () => {
  it("probes GET /api/tts/local-inference/status", async () => {
    fetchWithCsrfMock.mockResolvedValue(
      jsonResponse({ ready: true, provider: "local-inference" }),
    );
    await isLocalInferenceTtsReady();
    const [url, init] = fetchWithCsrfMock.mock.calls[0] ?? [];
    expect(url).toBe("http://agent.local/api/tts/local-inference/status");
    expect((init as RequestInit).method).toBe("GET");
  });

  it("returns true when the server reports ready", async () => {
    fetchWithCsrfMock.mockResolvedValue(
      jsonResponse({ ready: true, provider: "local-inference" }),
    );
    await expect(isLocalInferenceTtsReady()).resolves.toBe(true);
  });

  it("returns false when the server reports not-ready", async () => {
    fetchWithCsrfMock.mockResolvedValue(
      jsonResponse({ ready: false, provider: null }),
    );
    await expect(isLocalInferenceTtsReady()).resolves.toBe(false);
  });

  it("fails closed on a non-2xx response", async () => {
    fetchWithCsrfMock.mockResolvedValue(jsonResponse({}, false, 503));
    await expect(isLocalInferenceTtsReady()).resolves.toBe(false);
  });

  it("fails closed on a non-JSON body", async () => {
    fetchWithCsrfMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    await expect(isLocalInferenceTtsReady()).resolves.toBe(false);
  });

  it("fails closed when the fetch throws (server unreachable)", async () => {
    fetchWithCsrfMock.mockRejectedValue(new Error("network down"));
    await expect(isLocalInferenceTtsReady()).resolves.toBe(false);
  });

  it("forwards an abort signal to fetch", async () => {
    fetchWithCsrfMock.mockResolvedValue(jsonResponse({ ready: true }));
    const controller = new AbortController();
    await isLocalInferenceTtsReady({ signal: controller.signal });
    const [, init] = fetchWithCsrfMock.mock.calls[0] ?? [];
    expect((init as RequestInit).signal).toBe(controller.signal);
  });
});
