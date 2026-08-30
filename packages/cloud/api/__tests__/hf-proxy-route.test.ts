/**
 * Tests for GET /api/v1/hf-proxy/[...path].
 *
 * The route is the authenticated server-side HuggingFace download proxy used by
 * cloud-linked devices: it requires a valid linked account, only forwards
 * genuine `/resolve/` download paths, refuses to run without the cloud-side
 * `HF_TOKEN`, and otherwise streams the upstream HuggingFace response straight
 * through with the cloud token attached.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";
import { resetHfProxyEgressQuotaForTests } from "@/lib/services/hf-proxy-egress-quota";
import * as loggerActual from "@/lib/utils/logger";

const requireGenerativeRouteCaller =
  mock<
    (c: unknown) => Promise<{
      user: { id: string; organization_id: string };
      apiKeyId: string | null;
      appScopeId: string | null;
    }>
  >();
const loggerInfo = mock<(...args: unknown[]) => void>();
const loggerWarn = mock<(...args: unknown[]) => void>();
const loggerError = mock<(...args: unknown[]) => void>();

mock.module("@/api-app/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller,
  getGenerativeExecutionContext: () => undefined,
  asGenerativeCacheApiError: () => null,
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
  resetHfProxyEgressQuotaForTests();
  loggerInfo.mockClear();
  loggerWarn.mockClear();
  loggerError.mockClear();
  requireGenerativeRouteCaller.mockResolvedValue({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: "key-1",
    appScopeId: null,
  });
});

afterEach(() => {
  setSystemTime();
  requireGenerativeRouteCaller.mockReset();
  loggerInfo.mockReset();
  loggerWarn.mockReset();
  loggerError.mockReset();
  globalThis.fetch = realFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

const RESOLVE_PATH = "elizaos/eliza-1/resolve/main/model.gguf";

function makeRequest(
  path: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://api.example.test/api/v1/hf-proxy/${path}`, {
    method: "GET",
    headers,
  });
}

describe("GET /api/v1/hf-proxy/[...path]", () => {
  test("requires authentication", async () => {
    // An unauthenticated request throws from the auth gate before any proxying.
    requireGenerativeRouteCaller.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), {
        name: "AuthenticationError",
      }),
    );

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
    });

    expect(res.status).toBe(401);
    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
  });

  test("returns the cached standing reason without contacting HuggingFace", async () => {
    requireGenerativeRouteCaller.mockRejectedValueOnce(
      new ApiError(403, "access_denied", "Organization is inactive", {
        reason: "organization_inactive",
      }),
    );
    const upstreamFetch = mock(async () => new Response("not reached"));
    globalThis.fetch = upstreamFetch as unknown as typeof fetch;

    const res = await app.fetch(makeRequest(RESOLVE_PATH), {
      HF_TOKEN: "hf-secret",
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "Organization is inactive",
      code: "access_denied",
      details: { reason: "organization_inactive" },
    });
    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
    expect(upstreamFetch).not.toHaveBeenCalled();
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

  test("enforces per-org monthly egress budget before streaming the next response", async () => {
    setSystemTime(new Date("2026-02-28T23:59:58.250Z"));
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
      MOCK_REDIS: "1",
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "12",
    };
    const first = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("12345678");

    const second = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(second.status).toBe(429);
    // 1.75 seconds remain until the March UTC bucket, rounded up per HTTP.
    expect(second.headers.get("Retry-After")).toBe("2");
    const body = (await second.json()) as {
      code?: string;
      limit_bytes?: number;
      used_bytes?: number;
    };
    expect(body.code).toBe("HF_PROXY_EGRESS_LIMIT");
    expect(body.limit_bytes).toBe(12);
    expect(body.used_bytes).toBe(8);
  });

  test("pre-check exhaustion advertises the next UTC month and admits its fresh bucket", async () => {
    setSystemTime(new Date("2026-01-31T23:59:59.999Z"));
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls += 1;
      const body = fetchCalls === 1 ? "123456789012" : "NEXT";
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(body.length),
        },
      });
    }) as unknown as typeof fetch;

    const env = {
      HF_TOKEN: "hf-secret",
      MOCK_REDIS: "1",
      HF_PROXY_MONTHLY_EGRESS_LIMIT_BYTES: "12",
    };
    const january = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(january.status).toBe(200);
    expect(await january.text()).toBe("123456789012");
    const blocked = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("1");
    expect(((await blocked.json()) as { code?: string }).code).toBe(
      "HF_PROXY_EGRESS_LIMIT",
    );
    expect(fetchCalls).toBe(1);

    setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    const admitted = await app.fetch(makeRequest(RESOLVE_PATH), env);
    expect(admitted.status).toBe(200);
    expect(await admitted.text()).toBe("NEXT");
    expect(fetchCalls).toBe(2);
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
