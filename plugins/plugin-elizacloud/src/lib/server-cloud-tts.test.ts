/**
 * `/api/tts/cloud` proxy handler (`handleCloudTtsPreviewRoute`) driven with
 * real node req/res fakes and a stubbed upstream fetch. Pins the #16425
 * contract — the client's per-utterance Idempotency-Key is forwarded upstream
 * so the cloud route can replay the direct attempt's committed reservation —
 * plus the handler's auth/validation/success/error envelope, the #16347
 * `ELIZA_TTS_DEBUG` contract (phases observably emitted on the structured
 * logger when the flag is set, silent otherwise), and the proxy fetch abort
 * so a stalled upstream cannot hang the warming `for (;;)` loop.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type http from "node:http";
import { addLogListener, type LogEntry } from "@elizaos/core";
import { _resetCloudSecretsForTesting } from "@elizaos/shared/elizacloud";
import {
  handleCloudSttRoute,
  handleCloudTtsPreviewRoute,
} from "./server-cloud-tts";

// The logger freezes its level at module init and the repo test setup defaults
// LOG_LEVEL to "error", which would gate the info-level tts lines (and their
// listener delivery) off. vi.hoisted runs before the imports above evaluate,
// so the logger initializes at "info" — the production default the
// ELIZA_TTS_DEBUG diagnostic is documented against.
vi.hoisted(() => {
  process.env.LOG_LEVEL = "info";
});

const prevApiKey = process.env.ELIZAOS_CLOUD_API_KEY;
const prevConfigPath = process.env.ELIZA_CONFIG_PATH;
const prevTtsDebug = process.env.ELIZA_TTS_DEBUG;
const realFetch = globalThis.fetch;

interface CapturedUpstream {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
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

/**
 * Models the bare agent server after `attachJsonBodyIfPresent`
 * (packages/agent/src/api/runtime-plugin-routes.ts) has already consumed the
 * stream for a JSON request: `req.body`/`req.rawBody` are populated and the
 * underlying stream is drained (iterating it yields zero bytes). #16348.
 */
function fakeReqPreParsed(
  parsed: Record<string, unknown>,
  headers: Record<string, string> = {},
): http.IncomingMessage {
  return {
    headers,
    body: parsed,
    rawBody: JSON.stringify(parsed),
    // Stream already drained upstream → yields nothing on re-read.
    async *[Symbol.asyncIterator]() {
      // no chunks
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
  _resetCloudSecretsForTesting();
  process.env.ELIZA_CONFIG_PATH = `/tmp/eliza-cloud-tts-test-missing-${process.pid}.json`;
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
      body:
        init?.body instanceof FormData
          ? init.body
          : init?.body
            ? JSON.parse(String(init.body))
            : null,
      signal: init?.signal,
    });
    return upstreamResponse();
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  _resetCloudSecretsForTesting();
  if (prevApiKey === undefined) delete process.env.ELIZAOS_CLOUD_API_KEY;
  else process.env.ELIZAOS_CLOUD_API_KEY = prevApiKey;
  if (prevConfigPath === undefined) delete process.env.ELIZA_CONFIG_PATH;
  else process.env.ELIZA_CONFIG_PATH = prevConfigPath;
  if (prevTtsDebug === undefined) delete process.env.ELIZA_TTS_DEBUG;
  else process.env.ELIZA_TTS_DEBUG = prevTtsDebug;
});

afterEach(() => {
  vi.useRealTimers();
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

  test("keeps deeply nested stage directions out of the upstream speech request", async () => {
    let nestedDirection = "";
    for (let layer = 0; layer < 12; layer += 1) {
      nestedDirection = `(secret-${layer} ${nestedDirection})`;
    }

    const { res, state } = fakeRes();
    await handleCloudTtsPreviewRoute(
      fakeReq(JSON.stringify({ text: `Say this. ${nestedDirection} Done.` })),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0].body).toMatchObject({ text: "Say this. Done." });
    expect(JSON.stringify(upstream[0].body)).not.toContain("secret-");
  });

  test("honors a host pre-parsed JSON body when the stream is already drained (#16348)", async () => {
    const { res, state } = fakeRes();
    await handleCloudTtsPreviewRoute(
      fakeReqPreParsed(
        { text: "pre-parsed on the bare server" },
        { "content-type": "application/json" },
      ),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(upstream.length).toBeGreaterThanOrEqual(1);
    expect(upstream[0].body).toMatchObject({
      text: "pre-parsed on the bare server",
    });
  });

  test("pre-parsed body still forwards modelId/voiceId and the idempotency key (#16348)", async () => {
    const { res, state } = fakeRes();
    await handleCloudTtsPreviewRoute(
      fakeReqPreParsed(
        { text: "hi", modelId: "m-9", voiceId: "v-3" },
        {
          "content-type": "application/json",
          "idempotency-key": "utt-preparsed",
        },
      ),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(upstream[0].headers["Idempotency-Key"]).toBe("utt-preparsed");
    expect(upstream[0].body).toMatchObject({ text: "hi" });
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

  test("retries an explicit cache-warming 503 before returning audio", async () => {
    let calls = 0;
    upstreamResponse = () => {
      calls++;
      return calls === 1
        ? new Response(
            JSON.stringify({
              code: "service_unavailable",
              details: { retryable: true, retryAfterSeconds: 1 },
            }),
            { status: 503 },
          )
        : new Response(new Uint8Array([73, 68, 51]), {
            status: 200,
            headers: { "content-type": "audio/mpeg" },
          });
    };
    vi.useFakeTimers();

    const { res, state } = fakeRes();
    const handled = handleCloudTtsPreviewRoute(
      fakeReq(JSON.stringify({ text: "warm up" })),
      res,
    );
    await vi.runAllTimersAsync();
    await handled;

    expect(state.statusCode).toBe(200);
    expect(upstream).toHaveLength(2);
  });

  test("passes an abort signal on the default TTS timeout", async () => {
    const { res, state } = fakeRes();
    await handleCloudTtsPreviewRoute(
      fakeReq(JSON.stringify({ text: "signal me" })),
      res,
    );
    expect(state.statusCode).toBe(200);
    expect(upstream[0]?.signal).toBeDefined();
    expect(upstream[0]?.signal?.aborted).toBe(false);
  });

  test("aborts a hanging TTS upstream instead of waiting forever", async () => {
    const prevTimeout = process.env.ELIZAOS_CLOUD_TTS_TIMEOUT_MS;
    process.env.ELIZAOS_CLOUD_TTS_TIMEOUT_MS = "50";
    globalThis.fetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      upstream.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        signal: init?.signal,
      });
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const abort = () =>
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }) as typeof fetch;
    try {
      const { res, state } = fakeRes();
      await handleCloudTtsPreviewRoute(
        fakeReq(JSON.stringify({ text: "do not hang" })),
        res,
      );
      expect(state.statusCode).toBe(502);
      expect(String(state.body)).toMatch(/aborted|timeout/i);
    } finally {
      if (prevTimeout === undefined) {
        delete process.env.ELIZAOS_CLOUD_TTS_TIMEOUT_MS;
      } else {
        process.env.ELIZAOS_CLOUD_TTS_TIMEOUT_MS = prevTimeout;
      }
    }
  });
});

describe("handleCloudSttRoute (/api/asr/cloud proxy)", () => {
  test("retries an explicit cache-warming 503 before returning a transcript", async () => {
    let calls = 0;
    upstreamResponse = () => {
      calls++;
      return calls === 1
        ? new Response(
            JSON.stringify({
              code: "service_unavailable",
              details: { retryable: true, retryAfterSeconds: 1 },
            }),
            { status: 503 },
          )
        : Response.json({ text: "The quick brown fox." });
    };
    vi.useFakeTimers();

    const { res, state } = fakeRes();
    const handled = handleCloudSttRoute(
      fakeReq("RIFF-audio", { "content-type": "audio/wav" }),
      res,
    );
    await vi.runAllTimersAsync();
    await handled;

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(String(state.body))).toEqual({
      text: "The quick brown fox.",
    });
    expect(upstream).toHaveLength(2);
    expect(upstream.every((request) => request.body instanceof FormData)).toBe(
      true,
    );
  });

  test("does not retry a non-warming 503", async () => {
    upstreamResponse = () =>
      new Response(JSON.stringify({ error: "Whisper unavailable" }), {
        status: 503,
      });
    const { res, state } = fakeRes();

    await handleCloudSttRoute(
      fakeReq("RIFF-audio", { "content-type": "audio/wav" }),
      res,
    );

    expect(state.statusCode).toBe(502);
    expect(upstream).toHaveLength(1);
  });

  test("aborts a hanging STT upstream instead of waiting forever", async () => {
    const prevTimeout = process.env.ELIZAOS_CLOUD_STT_TIMEOUT_MS;
    process.env.ELIZAOS_CLOUD_STT_TIMEOUT_MS = "50";
    globalThis.fetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      upstream.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body instanceof FormData ? init.body : null,
        signal: init?.signal,
      });
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const abort = () =>
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }) as typeof fetch;
    try {
      const { res, state } = fakeRes();
      await handleCloudSttRoute(
        fakeReq("RIFF-audio", { "content-type": "audio/wav" }),
        res,
      );
      expect(state.statusCode).toBe(502);
      expect(String(state.body)).toMatch(/aborted|timeout/i);
    } finally {
      if (prevTimeout === undefined) {
        delete process.env.ELIZAOS_CLOUD_STT_TIMEOUT_MS;
      } else {
        process.env.ELIZAOS_CLOUD_STT_TIMEOUT_MS = prevTimeout;
      }
    }
  });
});

// #16347: server-side ELIZA_TTS_DEBUG must actually emit — entries observed on
// the real structured logger's listener stream, driven through the real route.
describe("ELIZA_TTS_DEBUG tracing on /api/tts/cloud", () => {
  let entries: LogEntry[] = [];
  let unsubscribe: (() => void) | null = null;

  const ttsLines = () =>
    entries.filter((entry) => entry.msg.includes("[eliza][tts]"));

  beforeEach(() => {
    entries = [];
    unsubscribe?.();
    unsubscribe = addLogListener((entry) => entries.push(entry));
  });

  afterAll(() => {
    unsubscribe?.();
  });

  test("successful proxy emits proxy → upstream-ok → success phases", async () => {
    process.env.ELIZA_TTS_DEBUG = "1";
    const { res, state } = fakeRes();
    await handleCloudTtsPreviewRoute(
      fakeReq(JSON.stringify({ text: "trace me please" }), {
        "x-elizaos-tts-message-id": "msg-42",
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    const phases = ttsLines().map((entry) => entry.msg);
    expect(
      phases.some((m) => m.includes("[eliza][tts] server:cloud-tts:proxy")),
    ).toBe(true);
    expect(
      phases.some((m) =>
        m.includes("[eliza][tts] server:cloud-tts:upstream-ok"),
      ),
    ).toBe(true);
    expect(
      phases.some((m) => m.includes("[eliza][tts] server:cloud-tts:success")),
    ).toBe(true);
    // Client correlation header and spoken-text preview ride along.
    expect(phases.some((m) => m.includes("msg-42"))).toBe(true);
    expect(phases.some((m) => m.includes("trace me please"))).toBe(true);
  });

  test("missing cloud key emits a reject phase with the reason", async () => {
    process.env.ELIZA_TTS_DEBUG = "1";
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    const { res, state } = fakeRes();
    await handleCloudTtsPreviewRoute(
      fakeReq(JSON.stringify({ text: "hi" })),
      res,
    );

    expect(state.statusCode).toBe(401);
    const reject = ttsLines().find((entry) =>
      entry.msg.includes("server:cloud-tts:reject"),
    );
    expect(reject).toBeDefined();
    expect(reject?.msg).toContain("no_api_key");
  });

  test("flag unset → the same successful request emits zero tts lines", async () => {
    delete process.env.ELIZA_TTS_DEBUG;
    const { res, state } = fakeRes();
    await handleCloudTtsPreviewRoute(
      fakeReq(JSON.stringify({ text: "silent run" })),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(ttsLines()).toHaveLength(0);
  });
});
