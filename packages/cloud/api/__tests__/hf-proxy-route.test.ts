/**
 * Tests for GET /api/v1/hf-proxy/[...path].
 *
 * The route is the authenticated server-side HuggingFace download proxy used by
 * cloud-linked devices: it requires a valid linked account, only forwards
 * genuine `/resolve/` download paths, refuses to run without the cloud-side
 * `HF_TOKEN`, and otherwise streams the upstream HuggingFace response straight
 * through with the cloud token attached.
 *
 * Egress quota coverage (#13115): atomic upfront reservation before the upstream
 * fetch, reservation amendment to the real content-length after headers, mid-stream
 * allowance enforcement, and cancellation accounting on downstream disconnect.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Hono } from "hono";
// Spread the real module: bun's `mock.module` replaces the registry entry
// process-wide, so dropping the other real exports of workers-hono-auth would
// break every later test file that imports from it.
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as loggerActual from "@/lib/utils/logger";

const requireUserOrApiKeyWithOrg =
  mock<(c: unknown) => Promise<{ id: string; organization_id: string }>>();
const loggerInfo = mock<(...args: unknown[]) => void>();
const loggerWarn = mock<(...args: unknown[]) => void>();
const loggerError = mock<(...args: unknown[]) => void>();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
    debug: () => undefined,
  },
}));

// The route reads `c.req.param("*")`, which is only populated when the app is
// mounted under the named-splat path the codegen emits in `_router.generated`.
// Mount it the same way so the test exercises the real path resolution.
const HF_PROXY_MOUNT = "/api/v1/hf-proxy/:*{.+}";

let app: Hono;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  const { default: hfProxyRoute } = (await import(
    "../v1/hf-proxy/[...path]/route"
  )) as { default: Parameters<Hono["route"]>[1] };
  app = new Hono().route(HF_PROXY_MOUNT, hfProxyRoute);
});

beforeEach(() => {
  loggerInfo.mockClear();
  loggerWarn.mockClear();
  loggerError.mockClear();
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: "user-1",
    organization_id: "org-1",
  });
});

afterEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  loggerInfo.mockReset();
  loggerWarn.mockReset();
  loggerError.mockReset();
  globalThis.fetch = realFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

const RESOLVE_PATH = "elizaos/eliza-1/resolve/main/model.gguf";

function fakeKv() {
  const map = new Map<string, string>();
  return {
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    list: async () => ({
      keys: [...map.keys()].map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

function makeRequest(
  path: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://api.example.test/api/v1/hf-proxy/${path}`, {
    method: "GET",
    headers,
  });
}

/**
 * Build a fetch mock that returns a body stream controlled by the test, so we
 * can drive chunked streaming and verify mid-stream allowance enforcement.
 */
function streamingFetchMock(
  chunks: Uint8Array[],
  options: {
    status?: number;
    headers?: Record<string, string>;
    delayMs?: number;
  } = {},
) {
  const status = options.status ?? 200;
  const headers = options.headers ?? {};
  const delayMs = options.delayMs ?? 0;
  const fn = async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        }
        controller.close();
      },
    });
    return new Response(body, { status, headers });
  };
  return mock(fn) as unknown as typeof fetch;
}

describe("GET /api/v1/hf-proxy/[...path]", () => {
  test("requires authentication", async () => {
    // An unauthenticated request throws from the auth gate before any proxying.
    requireUserOrApiKeyWithOrg.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), {
        name: "AuthenticationError",
      }),
    );

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
    });

    expect(res.status).toBe(401);
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
  });

  test("rejects a non-/resolve/ path with 400", async () => {
    const res = await app.fetch(makeRequest("elizaos/eliza-1/tree/main"), {
      HF_TOKEN: "hf-secret",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Only HuggingFace resolve paths are proxied.");
  });

  test("rejects a resolve path for a repo outside the curated catalog with 403", async () => {
    // A well-formed resolve path, but for an arbitrary non-elizaos repo — the
    // cloud HF_TOKEN must not be spent proxying it.
    let fetchCalled = false;
    globalThis.fetch = mock(async () => {
      fetchCalled = true;
      return new Response("SHOULD-NOT-REACH", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await app.fetch(
      makeRequest("someuser/gated-model/resolve/main/weights.gguf"),
      { HF_TOKEN: "hf-secret" },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(
      "This HuggingFace repo is not available through the proxy.",
    );
    // Never reaches upstream HuggingFace for a disallowed repo.
    expect(fetchCalled).toBe(false);
  });

  test("returns 503 when HF_TOKEN is not configured", async () => {
    const res = await app.fetch(makeRequest(RESOLVE_PATH), {});

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(
      "HuggingFace proxy is not configured on this deployment.",
    );
  });

  test("proxies a valid /resolve/ request through to HuggingFace with the cloud token", async () => {
    let capturedUrl: string | undefined;
    let capturedAuth: string | null | undefined;
    let capturedRange: string | null | undefined;

    globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
      capturedUrl = String(input);
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("authorization");
      capturedRange = headers.get("range");
      return new Response("GGUF-BYTES", {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "10",
          "accept-ranges": "bytes",
        },
      });
    }) as unknown as typeof fetch;

    const res = await app.fetch(
      makeRequest(`${RESOLVE_PATH}?download=true`, { range: "bytes=0-9" }),
      { HF_TOKEN: "hf-secret" },
    );

    expect(res.status).toBe(200);
    // Reconstructs the upstream HuggingFace URL 1:1, preserving the query.
    expect(capturedUrl).toBe(
      `https://huggingface.co/${RESOLVE_PATH}?download=true`,
    );
    // Attaches the cloud-side HF token, never a client-supplied one.
    expect(capturedAuth).toBe("Bearer hf-secret");
    // Forwards Range so resumable downloads work.
    expect(capturedRange).toBe("bytes=0-9");

    // Streams the upstream body and preserves download-relevant headers.
    expect(await res.text()).toBe("GGUF-BYTES");
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("accept-ranges")).toBe("bytes");

    // Cost observability: the proxied transfer is recorded with the repo, path,
    // status, and byte count so an operator can attribute unmetered downloads.
    const usageCall = loggerInfo.mock.calls.find(
      (call) => call[0] === "[hf-proxy] proxied download",
    );
    expect(usageCall).toBeDefined();
    const usagePayload = usageCall?.[1] as Record<string, unknown>;
    expect(usagePayload).toMatchObject({
      repo: "elizaos/eliza-1",
      path: RESOLVE_PATH,
      status: 200,
      bytes: 10,
    });
    // Identity is attached (redacted) so usage is attributable.
    expect(usagePayload.orgId).toBeDefined();
    expect(usagePayload.userId).toBeDefined();

    expect(loggerInfo).toHaveBeenCalledWith(
      "[hf-proxy] egress metric",
      expect.objectContaining({
        organizationId: "org-1",
        repo: "elizaos/eliza-1",
        bytes: 10,
        status: 200,
      }),
    );
  });

  test("returns structured HF_GATED for upstream 401/403", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("private", {
          status: 403,
          headers: { "content-type": "text/plain" },
        }),
    ) as unknown as typeof fetch;

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: string;
      code: string;
      repo: string;
    };
    expect(body).toEqual({
      error: "HuggingFace repo is gated or unauthorized.",
      code: "HF_GATED",
      repo: "elizaos/eliza-1",
    });
  });

  test("enforces per-org monthly egress budget — first download that fits is allowed, the over-budget second is rejected", async () => {
    const kv = fakeKv();
    globalThis.fetch = mock(
      async () =>
        new Response("12345678", {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "8",
          },
        }),
    ) as unknown as typeof fetch;

    const env = {
      HF_TOKEN: "hf-secret",
      CACHE_KV: kv,
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "12",
    };
    const first = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("12345678");

    const second = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(second.status).toBe(429);
    const body = (await second.json()) as {
      code?: string;
      limit_bytes?: number;
      used_bytes?: number;
    };
    expect(body.code).toBe("HF_PROXY_EGRESS_LIMIT");
    expect(body.limit_bytes).toBe(12);
    expect(body.used_bytes).toBe(8);
  });

  test("releases the reservation and records zero egress on upstream 401/403 so the failed download does not consume the budget", async () => {
    const kv = fakeKv();
    globalThis.fetch = mock(
      async () =>
        new Response("denied", {
          status: 403,
          headers: { "content-type": "text/plain" },
        }),
    ) as unknown as typeof fetch;

    const env = {
      HF_TOKEN: "hf-secret",
      CACHE_KV: kv,
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "12",
    };

    const denied = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(denied.status).toBe(403);

    // The gated download must not have consumed any of the 12-byte budget — a
    // subsequent valid request should still have the full budget available.
    globalThis.fetch = mock(
      async () =>
        new Response("12345678", {
          status: 200,
          headers: { "content-length": "8" },
        }),
    ) as unknown as typeof fetch;
    const ok = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345678");
  });

  test("a known content-length larger than the remaining budget is rejected with 429 before streaming (no partial egress)", async () => {
    const kv = fakeKv();
    globalThis.fetch = mock(
      async () =>
        new Response("x".repeat(20), {
          status: 200,
          headers: { "content-length": "20" },
        }),
    ) as unknown as typeof fetch;

    const env = {
      HF_TOKEN: "hf-secret",
      CACHE_KV: kv,
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "12",
    };
    const res = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("HF_PROXY_EGRESS_LIMIT");
  });

  test("two concurrent requests cannot both spend the same remaining budget (atomic reservation)", async () => {
    // Budget of 10 bytes. Two 8-byte responses fire "concurrently" against the
    // same in-memory counter. In a single isolate (single-threaded JS), the
    // upfront reservation is atomic: the first reserves 10 (the full cap), the
    // second finds nothing left and gets 429 before even fetching upstream.
    const env = {
      HF_TOKEN: "hf-secret",
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "10",
    };
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response("12345678", {
        status: 200,
        headers: { "content-length": "8" },
      });
    }) as unknown as typeof fetch;

    const [a, b] = await Promise.all([
      app.fetch(makeRequest(RESOLVE_PATH), env),
      app.fetch(makeRequest(RESOLVE_PATH), env),
    ]);
    const statuses = [a.status, b.status].sort();
    // Exactly one must succeed and exactly one must be rejected. Both must NOT
    // be 200 — that would mean the reservation failed to prevent double-spend.
    expect(statuses).toContain(200);
    expect(statuses).toContain(429);
    // Only the winning request reached upstream HuggingFace.
    expect(fetchCount).toBe(1);
  });

  test("unknown-length stream (no content-length) is capped at the remaining budget and aborted mid-stream when exceeded", async () => {
    const kv = fakeKv();
    // Upstream returns a stream with NO content-length, emitting two 6-byte
    // chunks (12 bytes total). Budget is 10 bytes, so the second chunk must
    // push the running total over the allowance and trigger a mid-stream abort.
    globalThis.fetch = streamingFetchMock(
      [new TextEncoder().encode("123456"), new TextEncoder().encode("789012")],
      { headers: { "content-type": "application/octet-stream" } },
    );

    const env = {
      HF_TOKEN: "hf-secret",
      CACHE_KV: kv,
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "10",
    };
    const res = await app.fetch(makeRequest(RESOLVE_PATH), env);
    // The response starts streaming (200) but errors when the allowance is
    // exceeded. We consume the body to trigger the streaming pump.
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow(
      "HF_PROXY_EGRESS_LIMIT_EXCEEDED_MIDSTREAM",
    );

    // The 6 bytes actually streamed before the abort must be committed to the
    // monthly ledger, so a follow-up request sees them used.
    const metric = loggerInfo.mock.calls.find(
      (c) => c[0] === "[hf-proxy] egress metric",
    );
    expect(metric).toBeDefined();
    const payload = metric?.[1] as { bytes?: number; reason?: string };
    expect(payload.bytes).toBe(6);
    expect(payload.reason).toBe("cancelled");
  });

  test("partial bytes are accounted on downstream disconnect (cancel callback)", async () => {
    const kv = fakeKv();
    // A slow 3-chunk stream; the consumer will cancel after the first chunk.
    globalThis.fetch = streamingFetchMock(
      [
        new TextEncoder().encode("AAAA"),
        new TextEncoder().encode("BBBB"),
        new TextEncoder().encode("CCCC"),
      ],
      { delayMs: 5 },
    );

    const env = {
      HF_TOKEN: "hf-secret",
      CACHE_KV: kv,
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "100",
    };
    const res = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(res.status).toBe(200);

    // Read one chunk then cancel the stream (simulating client disconnect).
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(value?.byteLength).toBe(4);
    await reader.cancel("client-disconnect");

    // Give the async cancel/finalize a tick to flush.
    await new Promise((r) => setTimeout(r, 20));

    const metric = loggerInfo.mock.calls.find(
      (c) => c[0] === "[hf-proxy] egress metric",
    );
    expect(metric).toBeDefined();
    const payload = metric?.[1] as { bytes?: number; reason?: string };
    // Only the 4 bytes actually delivered before disconnect are charged.
    expect(payload.bytes).toBe(4);
    expect(payload.reason).toBe("cancelled");
  });
});

/**
 * In-process Durable Object simulation for cross-isolate tests.
 *
 * The HfProxyEgressGate DO serializes all operations per org. This fake
 * creates a single shared storage map that multiple stub instances (simulating
 * separate Cloudflare isolates) read from and write to, proving that two
 * isolates sharing the same DO cannot both reserve against the same budget.
 *
 * The DO's actual serialization is guaranteed by Cloudflare's actor model;
 * this fake proves the *state-sharing* invariant (both isolates see the same
 * committed total and in-flight reservations) which the old KV path violated.
 */
function fakeEgressGateNamespace(_orgId: string, _limitBytes: number) {
  // Shared state — this is what a real DO persists in its storage.
  const storage = {
    committed: 0,
    reservations: new Map<string, { reserved: number; createdAt: number }>(),
  };

  function jsonResp(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  async function handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.pathname;
    const body = (await request.json()) as Record<string, unknown>;

    if (op === "/reserve") {
      const bytes = body.bytes as number;
      const limit = body.limitBytes as number;
      let inFlight = 0;
      for (const r of storage.reservations.values()) inFlight += r.reserved;
      const available = limit - storage.committed - inFlight;
      if (bytes > available) {
        return jsonResp({
          admitted: false,
          reservationId: null,
          committed: storage.committed,
          inFlight,
        });
      }
      const id = crypto.randomUUID();
      storage.reservations.set(id, { reserved: bytes, createdAt: Date.now() });
      return jsonResp({
        admitted: true,
        reservationId: id,
        committed: storage.committed,
        inFlight,
      });
    }

    if (op === "/amend") {
      const reservationId = body.reservationId as string;
      const actualBytes = body.actualBytes as number;
      const limit = body.limitBytes as number;
      const current = storage.reservations.get(reservationId);
      if (current === undefined) {
        return jsonResp({
          ok: false,
          committed: storage.committed,
          inFlight: 0,
        });
      }
      if (actualBytes <= current.reserved) {
        storage.reservations.set(reservationId, {
          reserved: actualBytes,
          createdAt: current.createdAt,
        });
        return jsonResp({
          ok: true,
          committed: storage.committed,
          inFlight: 0,
        });
      }
      // Grow: re-check
      const oldReserved = current.reserved;
      storage.reservations.set(reservationId, {
        reserved: 0,
        createdAt: current.createdAt,
      });
      let inFlight = 0;
      for (const r of storage.reservations.values()) inFlight += r.reserved;
      const available = limit - storage.committed - inFlight;
      if (actualBytes > available) {
        storage.reservations.set(reservationId, {
          reserved: oldReserved,
          createdAt: current.createdAt,
        });
        return jsonResp({ ok: false, committed: storage.committed, inFlight });
      }
      storage.reservations.set(reservationId, {
        reserved: actualBytes,
        createdAt: current.createdAt,
      });
      return jsonResp({ ok: true, committed: storage.committed, inFlight });
    }

    if (op === "/commit") {
      const reservationId = body.reservationId as string;
      const bytes = body.bytes as number;
      if (!storage.reservations.has(reservationId)) {
        return jsonResp({ committed: storage.committed });
      }
      storage.reservations.delete(reservationId);
      if (bytes > 0) storage.committed += bytes;
      return jsonResp({ committed: storage.committed });
    }

    if (op === "/release") {
      const reservationId = body.reservationId as string;
      storage.reservations.delete(reservationId);
      return jsonResp({ released: true });
    }

    if (op === "/read") {
      let inFlight = 0;
      for (const r of storage.reservations.values()) inFlight += r.reserved;
      return jsonResp({ committed: storage.committed, inFlight });
    }

    return new Response("Not found", { status: 404 });
  }

  // Each stub simulates a separate Cloudflare isolate making a fetch to the
  // same Durable Object (same shared storage).
  const stub = {
    fetch: (request: RequestInfo | URL, init?: RequestInit) =>
      handleFetch(new Request(request, init)),
  };

  const namespace = {
    getByName: (_name: string) => stub,
    // Expose for test assertions
    _storage: storage,
  };

  return namespace;
}

describe("Cross-isolate atomic egress quota (Durable Object path)", () => {
  test("two sequential KV-backed commits do not lose an increment when a DO is present", async () => {
    // Simulates two isolates each streaming 5 bytes. With the DO, both
    // commits land on the shared ledger — no lost update. Budget is 20.
    const limit = 20;
    const ns = fakeEgressGateNamespace("org-1", limit);

    const env = {
      HF_TOKEN: "hf-secret",
      HF_PROXY_EGRESS_GATES: ns,
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: String(limit),
    };

    globalThis.fetch = mock(
      async () =>
        new Response("12345", {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "5",
          },
        }),
    ) as unknown as typeof fetch;

    // Isolate A downloads 5 bytes.
    const resA = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(resA.status).toBe(200);
    expect(await resA.text()).toBe("12345");

    // Isolate B downloads another 5 bytes.
    const resB = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(resB.status).toBe(200);
    expect(await resB.text()).toBe("12345");

    // The committed total must be 10 — no lost increment.
    expect(ns._storage.committed).toBe(10);

    // A third request for more than the remaining 10 bytes must be rejected.
    globalThis.fetch = mock(
      async () =>
        new Response("x".repeat(15), {
          status: 200,
          headers: { "content-length": "15" },
        }),
    ) as unknown as typeof fetch;
    const resC = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(resC.status).toBe(429);
  });

  test("two overlapping reservations against the same shared budget cannot both succeed", async () => {
    // Budget of 10 bytes. Two "isolates" each try to reserve the full 10.
    // With the DO, the first reserves 10, the second finds 0 available and
    // is rejected — BEFORE any upstream fetch. This proves the cross-isolate
    // invariant the old isolate-local Map could not enforce.
    const limit = 10;
    const ns = fakeEgressGateNamespace("org-1", limit);

    const env = {
      HF_TOKEN: "hf-secret",
      HF_PROXY_EGRESS_GATES: ns,
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: String(limit),
    };

    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response("12345678", {
        status: 200,
        headers: { "content-length": "8" },
      });
    }) as unknown as typeof fetch;

    const [a, b] = await Promise.all([
      app.fetch(makeRequest(RESOLVE_PATH), env),
      app.fetch(makeRequest(RESOLVE_PATH), env),
    ]);
    const statuses = [a.status, b.status].sort();
    // Exactly one succeeds, exactly one rejected.
    expect(statuses).toContain(200);
    expect(statuses).toContain(429);
    // Only the winning request reached upstream.
    expect(fetchCount).toBe(1);
  });

  test("committed total survives across requests — no lost update on sequential commits", async () => {
    // Four sequential 5-byte downloads against a 20-byte budget. The committed
    // total must reach exactly 20, and the fifth request must be rejected.
    const limit = 20;
    const ns = fakeEgressGateNamespace("org-1", limit);

    const env = {
      HF_TOKEN: "hf-secret",
      HF_PROXY_EGRESS_GATES: ns,
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: String(limit),
    };

    globalThis.fetch = mock(
      async () =>
        new Response("12345", {
          status: 200,
          headers: { "content-length": "5" },
        }),
    ) as unknown as typeof fetch;

    for (let i = 0; i < 4; i++) {
      const res = await app.fetch(makeRequest(RESOLVE_PATH), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("12345");
    }

    expect(ns._storage.committed).toBe(20);

    const res5 = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(res5.status).toBe(429);
  });
});

describe("Upstream 4xx passthrough (non-401/403)", () => {
  test("upstream 404 is passed through, not masked as quota 429", async () => {
    const kv = fakeKv();
    globalThis.fetch = mock(
      async () =>
        new Response("not found", {
          status: 404,
          headers: { "content-type": "text/plain" },
        }),
    ) as unknown as typeof fetch;

    const env = {
      HF_TOKEN: "hf-secret",
      CACHE_KV: kv,
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "100",
    };

    const res = await app.fetch(makeRequest(RESOLVE_PATH), env);
    // The real upstream 404 must reach the client, not a 429 quota error.
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  test("upstream 429 is passed through with its body, not converted to quota 429", async () => {
    const kv = fakeKv();
    globalThis.fetch = mock(
      async () =>
        new Response('{"error":"rate limited"}', {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const env = {
      HF_TOKEN: "hf-secret",
      CACHE_KV: kv,
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "100",
    };

    const res = await app.fetch(makeRequest(RESOLVE_PATH), env);
    // The upstream 429 must be preserved — body, status, and all.
    expect(res.status).toBe(429);
    const body = await res.text();
    expect(body).toContain("rate limited");
    // It must NOT be our quota rejection shape.
    expect(body).not.toContain("HF_PROXY_EGRESS_LIMIT");
  });

  test("a successful 200 download after a 404 does not lose budget", async () => {
    const kv = fakeKv();
    // Budget of 12. First request gets a 404 (released). Second gets 8 bytes.
    globalThis.fetch = mock(
      async () =>
        new Response("not found", {
          status: 404,
          headers: { "content-type": "text/plain" },
        }),
    ) as unknown as typeof fetch;

    const env = {
      HF_TOKEN: "hf-secret",
      CACHE_KV: kv,
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "12",
    };

    const notFoundRes = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(notFoundRes.status).toBe(404);

    // The 404 must not have consumed budget — a subsequent 8-byte download
    // should still have the full 12-byte budget available.
    globalThis.fetch = mock(
      async () =>
        new Response("12345678", {
          status: 200,
          headers: { "content-length": "8" },
        }),
    ) as unknown as typeof fetch;
    const ok = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345678");
  });
});

describe("ALLOWED_REPO_PREFIX single-source-of-truth", () => {
  test("matches the org segment of ELIZA_1_HF_REPO from @elizaos/shared", async () => {
    // The route's allowlist prefix is a local literal (kept out of the worker
    // bundle's import graph on purpose), so it MUST be pinned to the shared
    // catalog constant — otherwise a rename of ELIZA_1_HF_REPO could silently
    // un-scope the proxy allowlist. This test is that pin.
    const { ALLOWED_REPO_PREFIX } = (await import(
      "../v1/hf-proxy/[...path]/route"
    )) as { ALLOWED_REPO_PREFIX: string };
    const { ELIZA_1_HF_REPO } = (await import(
      "@elizaos/shared/local-inference"
    )) as { ELIZA_1_HF_REPO: string };

    // ELIZA_1_HF_REPO is `<org>/<repo>` (e.g. "elizaos/eliza-1"); the allowlist
    // is the `<org>/` prefix. The curated repo must fall inside the allowlist.
    const org = ELIZA_1_HF_REPO.split("/")[0];
    expect(ALLOWED_REPO_PREFIX).toBe(`${org}/`);
    expect(ELIZA_1_HF_REPO.startsWith(ALLOWED_REPO_PREFIX)).toBe(true);
  });
});

describe("wrangler.toml DO binding coverage (#13115)", () => {
  test("every deployed environment binds HF_PROXY_EGRESS_GATES", async () => {
    // Durable Object bindings are non-inheritable in Wrangler: each
    // environment must declare its own. This test ensures staging and
    // production both bind HF_PROXY_EGRESS_GATES so the egress quota is
    // actually enforced cross-isolate in real deployments.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const tomlPath = resolve(import.meta.dir, "../wrangler.toml");
    const content = readFileSync(tomlPath, "utf-8");

    // Count occurrences of the binding across all sections.
    // Must appear in top-level + staging + production = 3 times.
    const occurrences =
      content.split('name = "HF_PROXY_EGRESS_GATES"').length - 1;

    // Must appear in top-level + staging + production = 3 times.
    expect(occurrences).toBeGreaterThanOrEqual(3);

    // Verify the migration tag is AFTER existing migrations (not before).
    const newMigrationIdx = content.indexOf('tag = "hf-proxy-egress-gates-v1"');
    const lastExistingMigrationIdx = content.indexOf(
      'tag = "onboarding-session-coordinator-v1"',
    );
    expect(newMigrationIdx).toBeGreaterThan(lastExistingMigrationIdx);
  });
});
