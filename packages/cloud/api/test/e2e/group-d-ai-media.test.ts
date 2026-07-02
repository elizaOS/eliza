/**
 * Group D — AI / inference / media routes.
 *
 * Covers five mounted routes from the Hono Worker:
 *
 *   /api/elevenlabs/stt      — protected legacy alias for /api/v1/voice/stt.
 *   /api/elevenlabs/tts      — protected legacy alias for /api/v1/voice/tts.
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
 * Each route gets:
 *   - Auth gate assertion (always runnable).
 *   - Happy-path reachability assertions avoid real provider calls by using
 *     inputs that validate auth and fail deterministically before upstream I/O.
 *   - Validation assertion for malformed bodies or unsupported methods.
 *
 * Skip behavior: with REQUIRE_E2E_SERVER=0 and no reachable Worker (or no
 * bootstrapped TEST_API_KEY) every test in this file reports as a counted,
 * named `skip` — never a silent pass. The /api/v1/responses happy path is
 * split into a keyless-deterministic variant (503, never 501) and a
 * live-inference variant (200 + full response shape) keyed on provider-key
 * availability.
 */

import { describe, expect, test } from "bun:test";

import {
  api,
  bearerHeaders,
  getBaseUrl,
  isServerReachable,
  url,
} from "./_helpers/api";

const serverReachable = await isServerReachable();
const hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
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
      "bootstrap a test API key. Tests will SKIP.",
  );
}

// Loud, counted skip instead of a silent pass when the Worker/key is absent.
const describeE2E = describe.skipIf(!serverReachable || !hasTestApiKey);

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

describeE2E("Group D — /api/v1/responses", () => {
  test("auth gate: missing credentials → 401", async () => {
    const res = await api.post("/api/v1/responses", {
      model: "google/gemini-2.5-flash",
      input: "hello",
    });
    expect(res.status).toBe(401);
  });

  test("validation: malformed body with auth returns 400", async () => {
    const res = await api.post(
      "/api/v1/responses",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
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
        { headers: bearerHeaders() },
      );
      expect(res.status).toBe(200);
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
