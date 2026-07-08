// @vitest-environment jsdom

// Tests the chunked-streaming segment POST leg (voice V2a): the `X-Asr-Segment`
// header wire shape, both-tier route selection (dedicated `/api/asr/cloud` vs
// shared-runtime `/api/v1/voice/stt`), the empty-segment-is-OK contract (unlike
// the batch whole-utterance path), and retry classification. Mirrors the stub
// setup in local-asr-transcribe.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithCsrf } from "../api/csrf-client";
import { resolveApiUrl } from "../utils";
import {
  encodeAsrSegmentHeader,
  transcribeCloudSegment,
} from "./local-asr-transcribe";

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: vi.fn(),
}));
vi.mock("../utils", () => ({
  resolveApiUrl: vi.fn((path: string) => `http://agent.local${path}`),
}));
vi.mock("../utils/eliza-globals", () => ({
  getElizaApiBase: vi.fn<() => string | undefined>(() => undefined),
}));

import { getElizaApiBase } from "../utils/eliza-globals";

const fetchWithCsrfMock = vi.mocked(fetchWithCsrf);
const getElizaApiBaseMock = vi.mocked(getElizaApiBase);

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const SEG = { sessionId: "sess-abc", seq: 2, isFinal: false } as const;

describe("encodeAsrSegmentHeader", () => {
  it("serializes to a compact sessionId;seq;isFinal triple", () => {
    expect(encodeAsrSegmentHeader(SEG)).toBe("sess-abc;2;0");
    expect(
      encodeAsrSegmentHeader({ sessionId: "x", seq: 5, isFinal: true }),
    ).toBe("x;5;1");
  });
});

describe("transcribeCloudSegment — dedicated tier", () => {
  afterEach(() => {
    vi.clearAllMocks();
    getElizaApiBaseMock.mockReturnValue(undefined);
  });

  it("POSTs raw WAV to /api/asr/cloud with the X-Asr-Segment header", async () => {
    fetchWithCsrfMock.mockResolvedValue(jsonResponse({ text: " on the " }));
    const wav = new Uint8Array([82, 73, 70, 70]);

    const text = await transcribeCloudSegment(wav, { segment: SEG });

    const [url, init] = fetchWithCsrfMock.mock.calls[0] ?? [];
    expect(url).toBe("http://agent.local/api/asr/cloud");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("audio/wav");
    expect(headers["X-Asr-Segment"]).toBe("sess-abc;2;0");
    expect(init?.body).toBe(wav);
    expect(text).toBe("on the");
  });

  it("returns '' for an empty segment transcript (NOT an error, unlike batch)", async () => {
    fetchWithCsrfMock.mockResolvedValue(jsonResponse({ text: "   " }));
    await expect(
      transcribeCloudSegment(new Uint8Array([1]), { segment: SEG }),
    ).resolves.toBe("");
  });

  it("throws on a terminal 401 (no retry)", async () => {
    fetchWithCsrfMock.mockResolvedValue(
      jsonResponse({ error: "no key" }, false, 401),
    );
    await expect(
      transcribeCloudSegment(new Uint8Array([1]), { segment: SEG }),
    ).rejects.toThrow(/segment 401/);
    expect(fetchWithCsrfMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on a 503 then succeeds", async () => {
    fetchWithCsrfMock
      .mockResolvedValueOnce(jsonResponse({ error: "upstream" }, false, 503))
      .mockResolvedValueOnce(jsonResponse({ text: "recovered" }));
    const text = await transcribeCloudSegment(new Uint8Array([1]), {
      segment: SEG,
    });
    expect(text).toBe("recovered");
    expect(fetchWithCsrfMock).toHaveBeenCalledTimes(2);
  });
});

describe("transcribeCloudSegment — shared-runtime tier", () => {
  afterEach(() => {
    vi.clearAllMocks();
    getElizaApiBaseMock.mockReturnValue(undefined);
  });

  it("routes to the v1 STT worker route with a multipart body + header", async () => {
    getElizaApiBaseMock.mockReturnValue(
      "https://cloud.example.com/api/v1/eliza/agents/agent-123",
    );
    fetchWithCsrfMock.mockResolvedValue(
      jsonResponse({ transcript: "shared tier text" }),
    );

    const text = await transcribeCloudSegment(new Uint8Array([1, 2, 3]), {
      segment: { sessionId: "s", seq: 0, isFinal: true },
    });

    const [url, init] = fetchWithCsrfMock.mock.calls[0] ?? [];
    expect(url).toBe("https://cloud.example.com/api/v1/voice/stt");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Asr-Segment"]).toBe("s;0;1");
    // Multipart body — no explicit Content-Type (browser sets the boundary).
    expect(headers["Content-Type"]).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);
    expect(text).toBe("shared tier text");
  });
});
