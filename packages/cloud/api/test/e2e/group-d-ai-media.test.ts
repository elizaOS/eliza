/**
 * Group D — AI / inference / media routes.
 *
 * Covers mounted routes from the Hono Worker:
 *
 *   /api/elevenlabs/stt      — protected legacy alias for /api/v1/voice/stt.
 *   /api/elevenlabs/tts      — protected legacy alias for /api/v1/voice/tts.
 *   /api/v1/voice/session/ws — public realtime voice WebSocket upgrade.
 *   /api/v1/responses        — protected Responses API compatibility route
 *                              backed by /api/v1/chat/completions.
 *   /api/v1/generate-image   — protected image generation route.
 *   /api/v1/generate-video   — protected video generation route.
 *   /api/fal/proxy           — public path in middleware; handler still
 *                              calls requireUserOrApiKeyWithOrg internally,
 *                              so no creds → handler returns auth error.
 *   /api/og                  — public; returns a Worker-native SVG image.
 *   /api/openapi.json        — public; returns the OpenAPI 3.1 spec as JSON.
 *
 * Authenticated HTTP routes get auth-gate coverage, and HTTP reachability
 * checks avoid provider calls with inputs that fail deterministically before
 * upstream I/O. The WebSocket check drives the complete upgrade and protocol
 * close over a real local socket.
 *
 * Skip behavior: with REQUIRE_E2E_SERVER=0, protected route suites report
 * counted, named skips when the Worker or bootstrapped TEST_API_KEY is absent.
 * The public WebSocket suite requires a reachable local Worker with
 * VOICE_REALTIME_WS_ENABLED=true. The /api/v1/responses happy path is split
 * into a keyless-deterministic variant (503, never 501) and a live-inference
 * variant (200 + full response shape) keyed on provider-key availability.
 */

import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";

import {
  api,
  bearerHeaders,
  getBaseUrl,
  isLocalTarget,
  isServerReachable,
  url,
} from "./_helpers/api";

const serverReachable = await isServerReachable();
const hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
const voiceRealtimeWsEnabled = process.env.VOICE_REALTIME_WS_ENABLED === "true";
if (!serverReachable) {
  console.warn(
    `[group-d-ai-media] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (bun run dev:api → wrangler dev) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}
if (!hasTestApiKey) {
  console.warn(
    "[group-d-ai-media] TEST_API_KEY is not set; the preload could not " +
      "bootstrap a test API key. Protected route tests will SKIP.",
  );
}

// Loud, counted skip instead of a silent pass when the Worker/key is absent.
const describeE2E = describe.skipIf(!serverReachable || !hasTestApiKey);
const describeLocalWorker = describe.skipIf(
  !serverReachable || !isLocalTarget() || !voiceRealtimeWsEnabled,
);

// Live-inference split: the local lane shares this process env with wrangler
// dev, so a provider key here means the Worker can really forward. A remote
// target (staging) opts in via E2E_LIVE_INFERENCE=1.
const liveInferenceAvailable = Boolean(
  process.env.OPENAI_API_KEY?.trim() ||
    process.env.AI_GATEWAY_API_KEY?.trim() ||
    process.env.E2E_LIVE_INFERENCE === "1",
);

function bearerOnlyHeaders(): Record<string, string> {
  const { Authorization } = bearerHeaders();
  return { Authorization };
}

interface VoiceWebSocketProbe {
  opened: boolean;
  statusCode: number | undefined;
  headers: Record<string, string>;
  serverFrame: unknown;
  closeCode: number;
  closeReason: string;
}

const VOICE_WS_ORIGIN = "https://localhost";

function maskedWebSocketFrame(opcode: number, payload: Uint8Array): Buffer {
  if (payload.byteLength > 125) {
    throw new Error("voice WebSocket probe only supports control-sized frames");
  }
  const mask = randomBytes(4);
  const frame = Buffer.alloc(2 + mask.byteLength + payload.byteLength);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | payload.byteLength;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.byteLength; index += 1) {
    frame[6 + index] = payload[index] ^ mask[index % mask.byteLength];
  }
  return frame;
}

function probeBinaryFirstVoiceWebSocket(): Promise<VoiceWebSocketProbe> {
  const endpoint = new URL("/api/v1/voice/session/ws", getBaseUrl());
  endpoint.searchParams.set("sessionId", "e2e-status-101");
  const websocketKey = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1")
    .update(`${websocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  return new Promise((resolve, reject) => {
    const port = Number(
      endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
    );
    const socket =
      endpoint.protocol === "https:"
        ? connectTls({
            host: endpoint.hostname,
            port,
            rejectUnauthorized: false,
          })
        : connectTcp({ host: endpoint.hostname, port });
    const connectEvent =
      endpoint.protocol === "https:" ? "secureConnect" : "connect";
    let opened = false;
    let statusCode: number | undefined;
    const headers: Record<string, string> = {};
    let serverFrame: unknown;
    let closeResult: VoiceWebSocketProbe | undefined;
    let handshakeComplete = false;
    let buffered = Buffer.alloc(0);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("voice WebSocket probe timed out"));
    }, 30_000);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    const readFrames = () => {
      while (buffered.byteLength >= 2) {
        const opcode = buffered[0] & 0x0f;
        const masked = (buffered[1] & 0x80) !== 0;
        let payloadLength = buffered[1] & 0x7f;
        let offset = 2;
        if (payloadLength === 126) {
          if (buffered.byteLength < 4) return;
          payloadLength = buffered.readUInt16BE(2);
          offset = 4;
        } else if (payloadLength === 127) {
          if (buffered.byteLength < 10) return;
          const extendedLength = buffered.readBigUInt64BE(2);
          if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            fail(new Error("voice WebSocket returned an oversized frame"));
            return;
          }
          payloadLength = Number(extendedLength);
          offset = 10;
        }
        if (masked) {
          fail(new Error("voice WebSocket server returned a masked frame"));
          return;
        }
        if (buffered.byteLength < offset + payloadLength) return;
        const payload = buffered.subarray(offset, offset + payloadLength);
        buffered = buffered.subarray(offset + payloadLength);

        if (opcode === 0x1) {
          try {
            serverFrame = JSON.parse(payload.toString("utf8"));
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        } else if (opcode === 0x2) {
          fail(
            new Error("voice WebSocket returned an unexpected binary frame"),
          );
          return;
        } else if (opcode === 0x8) {
          if (payload.byteLength < 2) {
            fail(
              new Error(
                "voice WebSocket returned a close frame without a code",
              ),
            );
            return;
          }
          if (closeResult) return;
          closeResult = {
            opened,
            statusCode,
            headers,
            serverFrame,
            closeCode: payload.readUInt16BE(0),
            closeReason: payload.subarray(2).toString("utf8"),
          };
          socket.write(maskedWebSocketFrame(0x8, payload));
          return;
        }
      }
    };

    // The wire handshake is intentional: Bun's WebSocket client does not expose
    // upgrade response headers, which are the contract under regression here.
    socket.once(connectEvent, () => {
      socket.write(
        `GET ${endpoint.pathname}${endpoint.search} HTTP/1.1\r\n` +
          `Host: ${endpoint.host}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${websocketKey}\r\n` +
          "Sec-WebSocket-Version: 13\r\n" +
          `Origin: ${VOICE_WS_ORIGIN}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!handshakeComplete) {
        const boundary = buffered.indexOf("\r\n\r\n");
        if (boundary === -1) return;
        const handshake = buffered.subarray(0, boundary).toString("latin1");
        buffered = buffered.subarray(boundary + 4);
        const [statusLine, ...headerLines] = handshake.split("\r\n");
        const statusMatch = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(statusLine);
        if (!statusMatch) {
          fail(
            new Error(
              `voice WebSocket returned an invalid status line: ${statusLine}`,
            ),
          );
          return;
        }
        statusCode = Number(statusMatch[1]);
        for (const line of headerLines) {
          const separator = line.indexOf(":");
          if (separator <= 0) continue;
          const name = line.slice(0, separator).trim().toLowerCase();
          const value = line.slice(separator + 1).trim();
          headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
        }
        if (statusCode !== 101) {
          fail(
            new Error(`voice WebSocket upgrade returned HTTP ${statusCode}`),
          );
          return;
        }
        const connectionTokens = headers.connection
          ?.split(",")
          .map((token) => token.trim().toLowerCase());
        if (
          headers.upgrade?.toLowerCase() !== "websocket" ||
          !connectionTokens?.includes("upgrade") ||
          headers["sec-websocket-accept"] !== expectedAccept
        ) {
          fail(
            new Error("voice WebSocket returned an invalid RFC6455 handshake"),
          );
          return;
        }
        handshakeComplete = true;
        opened = true;
        socket.write(maskedWebSocketFrame(0x2, new Uint8Array([1])));
      }
      readFrames();
    });
    socket.once("error", fail);
    socket.once("close", () => {
      if (settled) return;
      if (!closeResult) {
        fail(
          new Error("voice WebSocket transport closed without a close frame"),
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(closeResult);
    });
  });
}

describeE2E("Group D — /api/elevenlabs/stt", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.post("/api/elevenlabs/stt", { audio: "test-audio" });
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, handler is reachable without upstream STT", async () => {
    const form = new FormData();
    form.set(
      "audio",
      new File(["not audio"], "bad.wav", { type: "audio/wav" }),
    );
    const res = await fetch(url("/api/elevenlabs/stt"), {
      method: "POST",
      headers: bearerOnlyHeaders(),
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    // fileTypeFromBuffer cannot identify the bogus bytes → the route's own
    // signature validation rejects with 400 before any upstream STT I/O.
    expect(res.status).toBe(400);
  });

  test("validation: non-multipart body with auth returns 400", async () => {
    const res = await api.post("/api/elevenlabs/stt", "not-json", {
      headers: { ...bearerHeaders(), "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });
});

describeE2E("Group D — /api/elevenlabs/tts", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.post("/api/elevenlabs/tts", { text: "hello" });
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, handler is reachable without upstream TTS", async () => {
    const res = await api.post(
      "/api/elevenlabs/tts",
      { text: "x".repeat(5001) },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
  });

  test("validation: empty body with auth returns 400", async () => {
    const res = await api.post(
      "/api/elevenlabs/tts",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
  });
});

describeLocalWorker("Group D — /api/v1/voice/session/ws", () => {
  test("pinned workerd preserves a connected 101 upgrade through the real middleware chain", async () => {
    const probe = await probeBinaryFirstVoiceWebSocket();

    expect(probe.opened).toBe(true);
    expect(probe.statusCode).toBe(101);
    expect(probe.headers["access-control-allow-origin"]).toBe(VOICE_WS_ORIGIN);
    expect(probe.headers["access-control-allow-credentials"]).toBe("true");
    expect(probe.headers["x-content-type-options"]).toBe("nosniff");
    const requestId = probe.headers["x-request-id"];
    if (typeof requestId !== "string") {
      throw new Error("status-101 handshake omitted X-Request-Id");
    }
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    expect(probe.headers["x-eliza-trace-id"]).toBeUndefined();
    expect(probe.headers["server-timing"]).toBeUndefined();
    expect(probe.headers["timing-allow-origin"]).toBeUndefined();
    expect(probe.serverFrame).toEqual({
      t: "error",
      code: "hello_required",
      retryable: false,
    });
    expect(probe.closeCode).toBe(1008);
    expect(probe.closeReason).toBe("first frame must be a JSON hello");
  });
});

describeE2E("Group D — /api/v1/responses", () => {
  const traceId = "16098110-0000-4000-8000-000000000110";

  test("auth gate: missing credentials → 401", async () => {
    const res = await api.post(
      "/api/v1/responses",
      {
        model: "google/gemini-2.5-flash",
        input: "hello",
      },
      {
        headers: {
          Origin: "https://www.elizacloud.ai",
          "X-Eliza-Trace-Id": traceId,
        },
      },
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Eliza-Trace-Id")).toBe(traceId);
    expect(res.headers.get("Server-Timing")).toContain("cloud_worker;dur=");
    expect(res.headers.get("Timing-Allow-Origin")).toBe(
      "https://www.elizacloud.ai",
    );
    expect(
      res.headers.get("Access-Control-Expose-Headers")?.toLowerCase(),
    ).toContain("server-timing");
  });

  test("validation: malformed body with auth returns 400", async () => {
    const res = await api.post(
      "/api/v1/responses",
      {},
      {
        headers: {
          ...bearerHeaders(),
          "X-Eliza-Trace-Id": traceId,
        },
      },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("X-Eliza-Trace-Id")).toBe(traceId);
    expect(res.headers.get("Server-Timing")).toContain("cloud_worker;dur=");
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("missing_required_parameter");
  });

  test("validation: streaming requests return a clear 400", async () => {
    const res = await api.post(
      "/api/v1/responses",
      {
        model: "google/gemini-2.5-flash",
        input: "hello",
        stream: true,
      },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("/api/v1/chat/completions");
  });

  // Keyless-deterministic variant: without a provider key the route must
  // answer 503 (provider unavailable) — never 501 (unimplemented).
  test.skipIf(liveInferenceAvailable)(
    "keyless: non-streaming route answers 503 provider-unavailable, not 501",
    async () => {
      const res = await api.post(
        "/api/v1/responses",
        {
          model: "google/gemini-2.5-flash",
          instructions: "Reply briefly.",
          input: [{ role: "user", content: "Say hello" }],
        },
        { headers: bearerHeaders() },
      );
      expect(res.status).toBe(503);
    },
  );

  // Live variant: with a provider key the forward must fully succeed.
  test.skipIf(!liveInferenceAvailable)(
    "live: non-streaming route returns a complete response object",
    async () => {
      const res = await api.post(
        "/api/v1/responses",
        {
          model: "google/gemini-2.5-flash",
          instructions: "Reply briefly.",
          input: [{ role: "user", content: "Say hello" }],
        },
        {
          headers: {
            ...bearerHeaders(),
            "X-Eliza-Trace-Id": traceId,
          },
        },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Eliza-Trace-Id")).toBe(traceId);
      expect(res.headers.get("X-Eliza-Preforward-Ms")).toMatch(
        /^total=\d+(?:\.\d+)?;auth=\d+(?:\.\d+)?;mid=\d+(?:\.\d+)?;reserve=\d+(?:\.\d+)?;setup=\d+(?:\.\d+)?$/,
      );
      expect(res.headers.get("Server-Timing")).toContain(
        "gateway_preforward;dur=",
      );
      const body = (await res.json()) as {
        object?: string;
        output_text?: string;
        output?: unknown[];
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
        };
      };
      expect(body.object).toBe("response");
      expect(typeof body.output_text).toBe("string");
      expect(Array.isArray(body.output)).toBe(true);
      expect(typeof body.usage?.total_tokens).toBe("number");
    },
  );
});

describeE2E("Group D — /api/v1/generate-image", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.post("/api/v1/generate-image", {
      prompt: "A simple red circle",
    });
    expect(res.status).toBe(401);
  });

  test("validation: malformed body with auth returns 400", async () => {
    const res = await api.post(
      "/api/v1/generate-image",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(501);
  });

  test("validation: unsupported model is rejected before provider I/O", async () => {
    const res = await api.post(
      "/api/v1/generate-image",
      { prompt: "A simple red circle", model: "unsupported/image-model" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: string;
      details?: { supportedModels?: string[] };
    };
    expect(body.error).toContain("Unsupported image model");
    expect(Array.isArray(body.details?.supportedModels)).toBe(true);
  });
});

describeE2E("Group D — /api/v1/generate-video", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.post("/api/v1/generate-video", {
      prompt: "A cinematic drone shot",
      model: "fal-ai/veo3",
    });
    expect(res.status).toBe(401);
  });

  test("validation: malformed body with auth returns 400", async () => {
    const res = await api.post(
      "/api/v1/generate-video",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(501);
  });

  test("validation: unsupported model is rejected before fal.ai I/O", async () => {
    const res = await api.post(
      "/api/v1/generate-video",
      { prompt: "A cinematic drone shot", model: "unsupported/video-model" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: string;
      details?: { supportedModels?: string[] };
    };
    expect(body.error).toContain("Unsupported video model");
    expect(Array.isArray(body.details?.supportedModels)).toBe(true);
  });
});

describeE2E("Group D — /api/fal/proxy", () => {
  test("auth gate: missing credentials → 401/403", async () => {
    // /api/fal/proxy is on the middleware public list, but the handler itself
    // calls requireUserOrApiKeyWithOrg, so an unauthenticated request should
    // be rejected with an auth error response.
    const res = await api.get("/api/fal/proxy");
    expect(res.status).toBe(401);
  });

  test("happy path: with Bearer, proxy handler is reachable without upstream fal.ai", async () => {
    const res = await api.get("/api/fal/proxy", { headers: bearerHeaders() });
    // Authed but without the x-fal-target-url header the proxy rejects with
    // its own 400 ("Invalid request") before any upstream fal.ai I/O.
    expect(res.status).toBe(400);
  });

  test("validation: PATCH (unsupported method) → not 200", async () => {
    // The handler only registers GET/POST/PUT. PATCH should not produce a
    // success — Hono returns 404 for unmatched methods on a sub-app.
    const res = await api.patch(
      "/api/fal/proxy",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });
});

describeE2E("Group D — /api/og", () => {
  test("public route: no auth required (no 401/403)", async () => {
    const res = await api.get("/api/og?title=hello");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test("happy path: returns a non-empty body with content-type set", async () => {
    const res = await api.get("/api/og?title=hello");
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("image/svg+xml");
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("<svg");
    expect(body).toContain("hello");
  });

  test("validation: missing title uses default image text", async () => {
    const res = await api.get("/api/og");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Eliza Cloud");
  });
});

describeE2E("Group D — /api/openapi.json", () => {
  test("public route: no auth required (no 401/403)", async () => {
    const res = await api.get("/api/openapi.json");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test("happy path: returns OpenAPI 3.1 JSON spec with required top-level fields", async () => {
    const res = await api.get("/api/openapi.json");
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
    const body = (await res.json()) as {
      openapi?: string;
      info?: { title?: string; version?: string };
      paths?: Record<string, unknown>;
      components?: { securitySchemes?: Record<string, unknown> };
    };
    expect(body.openapi).toBe("3.1.0");
    expect(body.info?.title).toBe("Eliza Cloud API");
    expect(body.info?.version).toBeTruthy();
    expect(body.paths).toBeDefined();
    expect(typeof body.paths).toBe("object");
    expect(body.components?.securitySchemes).toBeDefined();
  });

  test("validation: only GET is supported; POST/PUT/DELETE return non-200", async () => {
    const res = await api.post("/api/openapi.json", {});
    // Hono returns 404 for unmatched methods on a sub-app that only
    // registers GET.
    expect(res.status).toBe(404);
  });
});
