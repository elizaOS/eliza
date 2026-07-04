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
    error: () => undefined,
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
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: "user-1",
    organization_id: "org-1",
  });
});

afterEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  loggerInfo.mockReset();
  loggerWarn.mockReset();
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
