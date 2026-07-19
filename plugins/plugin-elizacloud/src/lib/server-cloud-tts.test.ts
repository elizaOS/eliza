/**
 * `/api/tts/cloud` proxy handler (`handleCloudTtsPreviewRoute`) driven with
 * real node req/res fakes and a stubbed upstream fetch. Pins the #16425
 * contract — the client's per-utterance Idempotency-Key is forwarded upstream
 * so the cloud route can replay the direct attempt's committed reservation —
 * plus the handler's auth/validation/success/error envelope.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type http from "node:http";
import { handleCloudTtsPreviewRoute } from "./server-cloud-tts";

const prevApiKey = process.env.ELIZAOS_CLOUD_API_KEY;
const realFetch = globalThis.fetch;

interface CapturedUpstream {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let upstream: CapturedUpstream[] = [];
let upstreamResponse: () => Response = () =>
  new Response(new Uint8Array([73, 68, 51]), {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });

function fakeReq(
  body: string,
  headers: Record<string, string> = {},
): http.IncomingMessage {
  const chunks = [Buffer.from(body)];
  return {
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as http.IncomingMessage;
}

function fakeRes(): {
  res: http.ServerResponse;
  state: {
    statusCode: number;
    headers: Record<string, string>;
    body: Buffer | string | null;
  };
} {
  const state = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: null as Buffer | string | null,
  };
  const res = {
    headersSent: false,
    set statusCode(code: number) {
      state.statusCode = code;
    },
    get statusCode() {
      return state.statusCode;
    },
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
    },
    end(payload?: Buffer | string) {
      state.body = payload ?? null;
    },
  } as unknown as http.ServerResponse;
  return { res, state };
}

beforeEach(() => {
  process.env.ELIZAOS_CLOUD_API_KEY = "test-cloud-key";
  upstream = [];
  upstreamResponse = () =>
    new Response(new Uint8Array([73, 68, 51]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    upstream.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return upstreamResponse();
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevApiKey === undefined) delete process.env.ELIZAOS_CLOUD_API_KEY;
  else process.env.ELIZAOS_CLOUD_API_KEY = prevApiKey;
});

describe("handleCloudTtsPreviewRoute (/api/tts/cloud proxy)", () => {
  test("forwards the client's Idempotency-Key upstream (#16425)", async () => {
    const { res, state } = fakeRes();
    await handleCloudTtsPreviewRoute(
      fakeReq(JSON.stringify({ text: "bill me once" }), {
        "idempotency-key": "utt-abc",
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(upstream.length).toBeGreaterThanOrEqual(1);
    expect(upstream[0].headers["Idempotency-Key"]).toBe("utt-abc");
    expect(upstream[0].body).toMatchObject({ text: "bill me once" });
  });

  test("no incoming key → no Idempotency-Key header upstream (unchanged shape)", async () => {
    const { res, state } = fakeRes();
    await handleCloudTtsPreviewRoute(fakeReq(JSON.stringify({ text: "hi" })), res);

    expect(state.statusCode).toBe(200);
    expect("Idempotency-Key" in upstream[0].headers).toBe(false);
  });

  test("pipes upstream audio back with no-store caching", async () => {
    const { res, state } = fakeRes();
    await handleCloudTtsPreviewRoute(fakeReq(JSON.stringify({ text: "hi" })), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers["content-type"]).toBe("audio/mpeg");
    expect(state.headers["cache-control"]).toBe("no-store");
    expect(Buffer.isBuffer(state.body)).toBe(true);
    expect(Array.from(state.body as Buffer)).toEqual([73, 68, 51]);
  });

  test("401 when Eliza Cloud is not connected — no upstream call", async () => {
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    const { res, state } = fakeRes();
    await handleCloudTtsPreviewRoute(fakeReq(JSON.stringify({ text: "hi" })), res);

    expect(state.statusCode).toBe(401);
    expect(upstream).toHaveLength(0);
  });

  test("400 on invalid JSON and on missing text — no upstream call", async () => {
    const bad = fakeRes();
    await handleCloudTtsPreviewRoute(fakeReq("{not json"), bad.res);
    expect(bad.state.statusCode).toBe(400);

    const missing = fakeRes();
    await handleCloudTtsPreviewRoute(fakeReq(JSON.stringify({})), missing.res);
    expect(missing.state.statusCode).toBe(400);

    expect(upstream).toHaveLength(0);
  });

  test("forwards a non-retryable upstream error status and body", async () => {
    upstreamResponse = () =>
      new Response(JSON.stringify({ error: "Insufficient credits" }), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    const { res, state } = fakeRes();
    await handleCloudTtsPreviewRoute(fakeReq(JSON.stringify({ text: "hi" })), res);

    expect(state.statusCode).toBe(402);
    expect(JSON.parse(String(state.body))).toMatchObject({
      error: "Insufficient credits",
    });
  });
});
