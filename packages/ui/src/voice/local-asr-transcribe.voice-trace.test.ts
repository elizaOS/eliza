// @vitest-environment jsdom

/**
 * Shared-runtime cloud STT trace propagation.
 *
 * The helper owns the retry loop, so this test locks the per-turn trace header
 * to a single value across the first failed attempt and the successful retry.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(),
}));

vi.mock("../utils/eliza-globals", () => ({
  getElizaApiBase: vi.fn(),
}));

vi.mock("../utils", () => ({
  resolveApiUrl: (path: string) => path,
}));

vi.mock("../utils/cloud-agent-base", () => ({
  normalizeDirectCloudSharedAgentApiBase: (value: string) =>
    value.replace(/\/bridge\/?$/, ""),
}));

import { fetchWithCsrf } from "../api/csrf-client";
import { getElizaApiBase } from "../utils/eliza-globals";
import { transcribeCloudWav } from "./local-asr-transcribe";
import { VOICE_TRACE_HEADER } from "./shared-runtime-voice";

const fetchWithCsrfMock = vi.mocked(fetchWithCsrf);
const getElizaApiBaseMock = vi.mocked(getElizaApiBase);

afterEach(() => {
  vi.clearAllMocks();
});

describe("transcribeCloudWav shared-runtime voice tracing", () => {
  it("sends the same trace id on the retry and parses the v1 transcript", async () => {
    getElizaApiBaseMock.mockReturnValue(
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1",
    );
    fetchWithCsrfMock
      .mockResolvedValueOnce(new Response("upstream busy", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ transcript: " hello traced voice " }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const text = await transcribeCloudWav(new Uint8Array([82, 73, 70, 70]), {
      traceId: "trace-turn-1",
      timeoutMs: 1000,
    });

    expect(text).toBe("hello traced voice");
    expect(fetchWithCsrfMock).toHaveBeenCalledTimes(2);
    for (const call of fetchWithCsrfMock.mock.calls) {
      expect(call[0]).toBe("https://api.elizacloud.ai/api/v1/voice/stt");
      expect((call[1] as RequestInit).headers).toMatchObject({
        Accept: "application/json",
        [VOICE_TRACE_HEADER]: "trace-turn-1",
      });
    }
  });

  it("does not add the v1 trace header on the dedicated cloud STT proxy path", async () => {
    getElizaApiBaseMock.mockReturnValue("https://agent-1.elizacloud.ai");
    fetchWithCsrfMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "dedicated" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await transcribeCloudWav(new Uint8Array([1, 2, 3]), {
      traceId: "trace-not-forwarded",
      timeoutMs: 1000,
    });

    expect(fetchWithCsrfMock).toHaveBeenCalledWith(
      "/api/asr/cloud",
      expect.objectContaining({
        headers: expect.not.objectContaining({
          [VOICE_TRACE_HEADER]: "trace-not-forwarded",
        }),
      }),
    );
  });
});
