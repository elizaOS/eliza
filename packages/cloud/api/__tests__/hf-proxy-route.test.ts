/**
 * Tests for GET /api/v1/hf-proxy/[...path].
 *
 * The route is the authenticated server-side HuggingFace download proxy used by
 * cloud-linked devices: it requires a valid linked account, only forwards
 * genuine `/resolve/` download paths, refuses to run without the cloud-side
 * `HF_TOKEN`, and otherwise streams the upstream HuggingFace response straight
 * through with the cloud token attached.
 *
 * Egress accounting and concurrency limits are enforced atomically by a
 * per-organization Durable Object (`HF_PROXY_GATES`). These tests exercise the
 * reserve → stream → settle/cancel lifecycle, concurrent requests, cancelled
 * partial streams, and adversarial gate failures.
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

/**
 * A fake Durable Object stub that simulates the per-org gate. It tracks
 * reservations, settlements, and cancels in-memory so tests can assert on
 * atomic accounting behavior.
 */
function fakeGateStub() {
  const slots = new Map<string, { reservedBytes: number; startedAt: number }>();
  let usedBytes = 0;
  const settleCalls: Array<{ requestId: string; actualBytes: number }> = [];
  const cancelCalls: string[] = [];

  const stub = {
    fetch: mock(async (request: Request) => {
      const url = new URL(request.url);
      const body = (await request.json()) as Record<string, unknown>;
      const path = url.pathname;

      if (path === "/reserve") {
        const requestId = body.requestId as string;
        const estimatedBytes = body.estimatedBytes as number;
        const limitBytes = body.limitBytes as number;
        const maxConcurrent = body.maxConcurrent as number;

        const existingSlot = slots.get(requestId);
        if (existingSlot) {
          const projectedBytes =
            usedBytes - existingSlot.reservedBytes + estimatedBytes;
          if (projectedBytes > limitBytes) {
            return Response.json(
              {
                admitted: false,
                usedBytes,
                limitBytes,
                activeDownloads: slots.size,
                maxConcurrent,
              },
              { status: 429 },
            );
          }
          usedBytes = projectedBytes;
          existingSlot.reservedBytes = estimatedBytes;
          return Response.json({
            admitted: true,
            usedBytes,
            limitBytes,
            activeDownloads: slots.size,
            maxConcurrent,
          });
        }

        const projectedBytes = usedBytes + estimatedBytes;
        if (slots.size >= maxConcurrent) {
          return Response.json(
            {
              admitted: false,
              usedBytes,
              limitBytes,
              activeDownloads: slots.size,
              maxConcurrent,
            },
            { status: 429 },
          );
        }
        if (projectedBytes > limitBytes) {
          return Response.json(
            {
              admitted: false,
              usedBytes,
              limitBytes,
              activeDownloads: slots.size,
              maxConcurrent,
            },
            { status: 429 },
          );
        }

        usedBytes = projectedBytes;
        slots.set(requestId, {
          reservedBytes: estimatedBytes,
          startedAt: Date.now(),
        });
        return Response.json({
          admitted: true,
          usedBytes,
          limitBytes,
          activeDownloads: slots.size,
          maxConcurrent,
        });
      }

      if (path === "/settle") {
        const requestId = body.requestId as string;
        const actualBytes = body.actualBytes as number;
        settleCalls.push({ requestId, actualBytes });
        const slot = slots.get(requestId);
        if (slot) {
          usedBytes = Math.max(0, usedBytes - slot.reservedBytes);
          usedBytes += actualBytes;
          slots.delete(requestId);
        } else {
          usedBytes += actualBytes;
        }
        return Response.json({ settled: true });
      }

      if (path === "/cancel") {
        const requestId = body.requestId as string;
        cancelCalls.push(requestId);
        const slot = slots.get(requestId);
        if (slot) {
          usedBytes = Math.max(0, usedBytes - slot.reservedBytes);
          slots.delete(requestId);
        }
        return Response.json({ cancelled: true });
      }

      return new Response("Not found", { status: 404 });
    }),
    _slots: slots,
    _usedBytes: () => usedBytes,
    _settleCalls: settleCalls,
    _cancelCalls: cancelCalls,
    _reset: () => {
      slots.clear();
      usedBytes = 0;
      settleCalls.length = 0;
      cancelCalls.length = 0;
    },
  };
  return stub;
}

function fakeGateNamespace(stub: ReturnType<typeof fakeGateStub>) {
  return {
    getByName: (_name: string) => stub,
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

function mockUpstream(
  body: string,
  status = 200,
  extraHeaders: Record<string, string> = {},
) {
  globalThis.fetch = mock(
    async () =>
      new Response(body, {
        status,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(body.length),
          "accept-ranges": "bytes",
          ...extraHeaders,
        },
      }),
  ) as unknown as typeof fetch;
}

describe("GET /api/v1/hf-proxy/[...path]", () => {
  test("requires authentication", async () => {
    const gate = fakeGateStub();
    requireUserOrApiKeyWithOrg.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), {
        name: "AuthenticationError",
      }),
    );

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: fakeGateNamespace(gate),
    });

    expect(res.status).toBe(401);
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
  });

  test("rejects a non-/resolve/ path with 400", async () => {
    const gate = fakeGateStub();
    const res = await app.fetch(makeRequest("elizaos/eliza-1/tree/main"), {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: fakeGateNamespace(gate),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Only HuggingFace resolve paths are proxied.");
  });

  test("rejects a resolve path for a repo outside the curated catalog with 403", async () => {
    const gate = fakeGateStub();
    let fetchCalled = false;
    globalThis.fetch = mock(async () => {
      fetchCalled = true;
      return new Response("SHOULD-NOT-REACH", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await app.fetch(
      makeRequest("someuser/gated-model/resolve/main/weights.gguf"),
      { HF_TOKEN: "hf-secret", HF_PROXY_GATES: fakeGateNamespace(gate) },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(
      "This HuggingFace repo is not available through the proxy.",
    );
    expect(fetchCalled).toBe(false);
  });

  test("returns 503 when HF_TOKEN is not configured", async () => {
    const gate = fakeGateStub();
    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_PROXY_GATES: fakeGateNamespace(gate),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(
      "HuggingFace proxy is not configured on this deployment.",
    );
  });

  test("returns 503 when HF_PROXY_GATES binding is missing", async () => {
    mockUpstream("GGUF-BYTES");
    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("HF_PROXY_GATE_UNAVAILABLE");
  });

  test("proxies a valid /resolve/ request through to HuggingFace with the cloud token", async () => {
    const gate = fakeGateStub();
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
      { HF_TOKEN: "hf-secret", HF_PROXY_GATES: fakeGateNamespace(gate) },
    );

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe(
      `https://huggingface.co/${RESOLVE_PATH}?download=true`,
    );
    expect(capturedAuth).toBe("Bearer hf-secret");
    expect(capturedRange).toBe("bytes=0-9");

    expect(await res.text()).toBe("GGUF-BYTES");
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("accept-ranges")).toBe("bytes");

    // Cost observability: the proxied transfer is recorded with the repo, path,
    // status, and byte count.
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
    expect(usagePayload.orgId).toBeDefined();
    expect(usagePayload.userId).toBeDefined();

    // The stream is settled with the actual byte count.
    await Promise.resolve(); // let the flush microtask run
    const settleCall = gate._settleCalls.find((s) => s.actualBytes === 10);
    expect(settleCall).toBeDefined();
  });

  test("returns structured HF_GATED for upstream 401/403 and cancels the slot", async () => {
    const gate = fakeGateStub();
    let upstreamCancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      cancel() {
        upstreamCancelled = true;
      },
    });
    globalThis.fetch = mock(
      async () =>
        new Response(upstreamBody, {
          status: 403,
          headers: { "content-type": "text/plain" },
        }),
    ) as unknown as typeof fetch;

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: fakeGateNamespace(gate),
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
    // A gated upstream must release the concurrency slot.
    expect(gate._cancelCalls.length).toBeGreaterThanOrEqual(1);
    expect(upstreamCancelled).toBe(true);
  });

  test("strictly parses numeric configuration and Content-Length", async () => {
    const gate = fakeGateStub();
    globalThis.fetch = mock(
      async () =>
        new Response("12345678", {
          status: 200,
          headers: {
            "content-length": "9007199254740992",
          },
        }),
    ) as unknown as typeof fetch;

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: fakeGateNamespace(gate),
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "4junk",
      HF_PROXY_MAX_CONCURRENT_DOWNLOADS: "2junk",
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("12345678");
    expect(gate._settleCalls).toContainEqual({
      requestId: expect.any(String),
      actualBytes: 8,
    });
  });

  test("enforces per-org monthly egress budget before streaming", async () => {
    const gate = fakeGateStub();
    // Pre-set the gate to near-limit via a direct settle.
    // Use the reserve path: we manipulate the stub state directly.
    gate._slots.set("__seed__", { reservedBytes: 0, startedAt: Date.now() });
    // Use the fake's internal state to seed usedBytes
    (gate as unknown as { _usedBytes: () => number })._usedBytes = () => 0;

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
      HF_PROXY_GATES: fakeGateNamespace(gate),
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "12",
    };
    // First request succeeds and settles 8 bytes.
    const first = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("12345678");

    // Wait for settle.
    await Promise.resolve();

    // Second request: 8 bytes already used, limit 12. The atomic reservation
    // adjustment rejects Content-Length 8 before any body byte is forwarded.
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

  test("enforces per-org concurrency cap", async () => {
    const gate = fakeGateStub();

    // Simulate max concurrent slots already filled by pre-populating the stub.
    // maxConcurrent is passed via env as 2; we fill 2 slots manually.
    gate._slots.set("active-1", { reservedBytes: 0, startedAt: Date.now() });
    gate._slots.set("active-2", { reservedBytes: 0, startedAt: Date.now() });

    globalThis.fetch = mock(
      async () =>
        new Response("data", {
          status: 200,
          headers: { "content-length": "4" },
        }),
    ) as unknown as typeof fetch;

    const env = {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: fakeGateNamespace(gate),
      HF_PROXY_MAX_CONCURRENT_DOWNLOADS: "2",
    };

    const res = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      code?: string;
      active_downloads?: number;
      max_concurrent?: number;
    };
    expect(body.code).toBe("HF_PROXY_CONCURRENCY_LIMIT");
    expect(body.active_downloads).toBe(2);
    expect(body.max_concurrent).toBe(2);
  });

  test("atomically pre-charges concurrent Content-Length responses", async () => {
    const gate = fakeGateStub();
    mockUpstream("12345678");
    const env = {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: fakeGateNamespace(gate),
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "12",
    };

    const first = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(first.status).toBe(200);
    expect(gate._usedBytes()).toBe(8);

    const second = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      code: "HF_PROXY_EGRESS_LIMIT",
      used_bytes: 8,
    });

    expect(await first.text()).toBe("12345678");
  });

  test("cancels the upstream body when Content-Length exceeds the budget", async () => {
    const gate = fakeGateStub();
    let upstreamCancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      cancel() {
        upstreamCancelled = true;
      },
    });
    globalThis.fetch = mock(
      async () =>
        new Response(upstreamBody, {
          status: 200,
          headers: { "content-length": "8" },
        }),
    ) as unknown as typeof fetch;

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: fakeGateNamespace(gate),
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "4",
    });

    expect(res.status).toBe(429);
    expect(upstreamCancelled).toBe(true);
    expect(gate._cancelCalls).toHaveLength(1);
  });

  test("cancels upstream and the slot when Content-Length sizing fails", async () => {
    const cancelCalls: string[] = [];
    let reserveCalls = 0;
    const stub = {
      fetch: mock(async (request: Request) => {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as { requestId: string };
        if (path === "/reserve") {
          reserveCalls += 1;
          if (reserveCalls === 2) {
            return Response.json(
              { error: "storage unavailable" },
              { status: 503 },
            );
          }
          return Response.json({
            admitted: true,
            usedBytes: 0,
            limitBytes: 100,
            activeDownloads: 1,
            maxConcurrent: 4,
          });
        }
        if (path === "/cancel") {
          cancelCalls.push(body.requestId);
          return Response.json({ cancelled: true });
        }
        return Response.json({ renewed: true });
      }),
    };
    let upstreamCancelled = false;
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              upstreamCancelled = true;
            },
          }),
          { status: 200, headers: { "content-length": "8" } },
        ),
    ) as unknown as typeof fetch;

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: { getByName: () => stub },
    });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(upstreamCancelled).toBe(true);
    expect(cancelCalls).toHaveLength(1);
  });

  test("reserves unknown-length chunks before forwarding them", async () => {
    const gate = fakeGateStub();
    const upstreamStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("AAAA"));
        controller.enqueue(new TextEncoder().encode("BBBB"));
        controller.close();
      },
    });
    globalThis.fetch = mock(
      async () =>
        new Response(upstreamStream, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    ) as unknown as typeof fetch;

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: fakeGateNamespace(gate),
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "6",
    });
    const reader = res.body!.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toBe("AAAA");
    await expect(reader.read()).rejects.toThrow(
      "HF proxy egress limit reached while streaming",
    );
    expect(gate._usedBytes()).toBe(4);
    expect(gate._settleCalls).toContainEqual({
      requestId: expect.any(String),
      actualBytes: 4,
    });
  });

  test("charges actual bytes on cancelled partial streams", async () => {
    const gate = fakeGateStub();

    // Create a stream that the consumer will cancel after receiving some bytes.
    const chunks = ["AAAA", "BBBB", "CCCC", "DDDD"];
    const upstreamStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    globalThis.fetch = mock(
      async () =>
        new Response(upstreamStream, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    ) as unknown as typeof fetch;

    const env = {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: fakeGateNamespace(gate),
    };

    const res = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(res.status).toBe(200);

    // Read only the first chunk then cancel.
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(value).toBeDefined();
    expect(value!.byteLength).toBe(4);
    // Cancel the stream — simulating a client disconnect.
    await reader.cancel();

    // Give the cancel callback a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The stream must have been settled with at least the bytes consumed before
    // cancellation (4 bytes from the first chunk). This is the core fix: the
    // old code only charged on flush(), so a cancelled stream escaped entirely.
    const settleCall = gate._settleCalls[0];
    expect(settleCall).toBeDefined();
    expect(settleCall!.actualBytes).toBeGreaterThanOrEqual(4);
  });

  test("settles actual bytes on successful completion", async () => {
    const gate = fakeGateStub();
    const data = "COMPLETE-DATA";
    mockUpstream(data);

    const env = {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: fakeGateNamespace(gate),
    };

    const res = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(data);

    // Let the flush microtask run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const settleCall = gate._settleCalls[0];
    expect(settleCall).toBeDefined();
    expect(settleCall!.actualBytes).toBe(data.length);
  });

  test("settles a bodyless upstream response", async () => {
    const gate = fakeGateStub();
    globalThis.fetch = mock(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: fakeGateNamespace(gate),
    });

    expect(res.status).toBe(204);
    expect(gate._settleCalls).toContainEqual({
      requestId: expect.any(String),
      actualBytes: 0,
    });
    expect(gate._slots.size).toBe(0);
  });

  test("releases the slot when upstream fetch throws", async () => {
    const gate = fakeGateStub();
    globalThis.fetch = mock(async () => {
      throw new Error("Network error");
    }) as unknown as typeof fetch;

    const env = {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: fakeGateNamespace(gate),
    };

    const res = await app.fetch(makeRequest(RESOLVE_PATH), env);
    // failureResponse handles the thrown error.
    expect(res.status).toBeGreaterThanOrEqual(500);
    // The slot must be cancelled so it doesn't leak.
    expect(gate._cancelCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("does not treat non-2xx cancellation responses as success", async () => {
    const slots = new Set<string>();
    const stub = {
      fetch: mock(async (request: Request) => {
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as { requestId: string };
        if (path === "/reserve") {
          slots.add(body.requestId);
          return Response.json({
            admitted: true,
            usedBytes: 0,
            limitBytes: 100,
            activeDownloads: slots.size,
            maxConcurrent: 4,
          });
        }
        if (path === "/cancel") {
          return Response.json(
            { error: "storage unavailable" },
            { status: 503 },
          );
        }
        return Response.json({ settled: true });
      }),
    };
    globalThis.fetch = mock(
      async () => new Response("private", { status: 403 }),
    ) as unknown as typeof fetch;

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: { getByName: () => stub },
    });

    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  test("surfaces non-2xx settlement responses to the stream consumer", async () => {
    const stub = {
      fetch: mock(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/settle") {
          return Response.json(
            { error: "storage unavailable" },
            { status: 503 },
          );
        }
        return Response.json({
          admitted: true,
          usedBytes: 4,
          limitBytes: 100,
          activeDownloads: 1,
          maxConcurrent: 4,
        });
      }),
    };
    mockUpstream("data");

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: { getByName: () => stub },
    });
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data");
    await expect(reader.read()).rejects.toThrow(
      "HF proxy gate settlement failed with status 503",
    );
    expect(loggerInfo).not.toHaveBeenCalledWith(
      "[hf-proxy] egress metric",
      expect.anything(),
    );
  });

  test("returns 429 when the gate itself rejects with egress exhausted", async () => {
    // A gate stub that always rejects with egress exhausted.
    const stub = {
      fetch: mock(async () =>
        Response.json(
          {
            admitted: false,
            usedBytes: 600,
            limitBytes: 500,
            activeDownloads: 0,
            maxConcurrent: 4,
          },
          { status: 429 },
        ),
      ),
    };

    globalThis.fetch = mock(
      async () => new Response("x", { status: 200 }),
    ) as unknown as typeof fetch;

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
      HF_PROXY_GATES: { getByName: () => stub },
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      code?: string;
      limit_bytes?: number;
      used_bytes?: number;
    };
    expect(body.code).toBe("HF_PROXY_EGRESS_LIMIT");
    expect(body.limit_bytes).toBe(500);
    expect(body.used_bytes).toBe(600);
  });

  test("forwards Range header and preserves 206 Partial Content", async () => {
    const gate = fakeGateStub();
    let capturedRange: string | null | undefined;

    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedRange = headers.get("range");
      return new Response("PARTIAL", {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "7",
          "content-range": "bytes 0-6/100",
          "accept-ranges": "bytes",
        },
      });
    }) as unknown as typeof fetch;

    const res = await app.fetch(
      makeRequest(RESOLVE_PATH, { range: "bytes=0-6" }),
      { HF_TOKEN: "hf-secret", HF_PROXY_GATES: fakeGateNamespace(gate) },
    );

    expect(res.status).toBe(206);
    expect(capturedRange).toBe("bytes=0-6");
    expect(res.headers.get("content-range")).toBe("bytes 0-6/100");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("PARTIAL");
  });
});

describe("ALLOWED_REPO_PREFIX single-source-of-truth", () => {
  test("matches the org segment of ELIZA_1_HF_REPO from @elizaos/shared", async () => {
    const { ALLOWED_REPO_PREFIX } = (await import(
      "../v1/hf-proxy/[...path]/route"
    )) as { ALLOWED_REPO_PREFIX: string };
    const { ELIZA_1_HF_REPO } = (await import(
      "@elizaos/shared/local-inference"
    )) as { ELIZA_1_HF_REPO: string };

    const org = ELIZA_1_HF_REPO.split("/")[0];
    expect(ALLOWED_REPO_PREFIX).toBe(`${org}/`);
    expect(ELIZA_1_HF_REPO.startsWith(ALLOWED_REPO_PREFIX)).toBe(true);
  });
});
