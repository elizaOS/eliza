/**
 * Exercises the app-host Cloud-pair relay, scoped browser handoff, and managed
 * loopback gate with real HTTP fakes around a deterministic Cloud dependency.
 */
import * as http from "node:http";
import { Socket } from "node:net";
import { runInNewContext } from "node:vm";
import {
  CLOUD_PAIR_LEGACY_STORAGE_KEY,
  CLOUD_PAIR_LOCAL_OWNER_HINT_KEY,
  cloudPairTokenKeyForAgent,
} from "@elizaos/shared/contracts";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { _resetSensitiveLimiters } from "./auth/sensitive-rate-limit";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

let handleCloudPairRoute: typeof import("./cloud-pair-route").handleCloudPairRoute;

const AGENT_ID = "55555555-5555-4555-8555-555555555555";
const MANAGED_ENV_KEYS = [
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_CLOUD_PAIR_DIRECT_RELAY",
  "ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS",
  "ELIZA_CLOUD_AGENT_ID",
  "WAIFU_ELIZA_CLOUD_AGENT_ID",
  "ELIZAOS_CLOUD_BASE_URL",
  "NEXT_PUBLIC_API_URL",
] as const;
const originalManagedEnv = Object.fromEntries(
  MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function clearManagedEnv(): void {
  for (const key of MANAGED_ENV_KEYS) delete process.env[key];
}

function restoreManagedEnv(): void {
  for (const key of MANAGED_ENV_KEYS) {
    const value = originalManagedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

interface FakeRes {
  res: http.ServerResponse;
  body(): string;
  status(): number;
  headers(): Record<string, string>;
}

function executeHandoffHtml(html: string) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Cloud-pair handoff script was not rendered.");

  const sessionValues = new Map<string, string>();
  const localValues = new Map<string, string>();
  const storage = (values: Map<string, string>) => ({
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  });
  const replace = vi.fn();
  const windowObject: Record<PropertyKey, unknown> = {
    sessionStorage: storage(sessionValues),
    localStorage: storage(localValues),
    location: { hostname: "127.0.0.1", protocol: "http:", replace },
  };
  runInNewContext(script, {
    window: windowObject,
    document: { querySelector: () => ({ textContent: "" }) },
    console: { error: vi.fn() },
  });

  return { localValues, replace, sessionValues, windowObject };
}

function fakeRes(): FakeRes {
  let bodyText = "";
  let writtenStatus = 200;
  const writtenHeaders: Record<string, string> = {};
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.writeHead = ((
    status: number,
    headers?: Record<string, string>,
  ): http.ServerResponse => {
    writtenStatus = status;
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        writtenHeaders[key.toLowerCase()] = String(value);
      }
    }
    return res;
  }) as typeof res.writeHead;
  res.setHeader = ((
    key: string,
    value: string | string[],
  ): http.ServerResponse => {
    writtenHeaders[key.toLowerCase()] = Array.isArray(value)
      ? value.join(",")
      : value;
    return res;
  }) as typeof res.setHeader;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    body: () => bodyText,
    status: () => writtenStatus,
    headers: () => writtenHeaders,
  };
}

function fakeReq(opts: {
  pathname: string;
  search?: string;
  ip?: string;
  host?: string;
  proto?: string;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = "GET";
  req.url = `${opts.pathname}${opts.search ?? ""}`;
  req.headers = {
    host: opts.host ?? "127.0.0.1:43123",
    ...(opts.proto ? { "x-forwarded-proto": opts.proto } : {}),
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: opts.ip ?? "127.0.0.1",
    configurable: true,
  });
  return req;
}

const ORIGINAL_FETCH = globalThis.fetch;

beforeAll(async () => {
  const routeModule = await import("./cloud-pair-route");
  handleCloudPairRoute = routeModule.handleCloudPairRoute;
});

beforeEach(() => {
  _resetSensitiveLimiters();
  clearManagedEnv();
  process.env.ELIZA_CLOUD_PROVISIONED = "1";
  process.env.ELIZA_CLOUD_PAIR_DIRECT_RELAY = "1";
  process.env.ELIZA_CLOUD_AGENT_ID = AGENT_ID;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  restoreManagedEnv();
});

describe("handleCloudPairRoute", () => {
  it("returns false for non-/pair paths so the dispatch chain keeps walking", async () => {
    const { res } = fakeRes();
    const req = fakeReq({ pathname: "/something-else" });
    const handled = await handleCloudPairRoute(req, res);
    expect(handled).toBe(false);
  });

  it("returns false for non-GET methods on /pair", async () => {
    const { res } = fakeRes();
    const req = fakeReq({ pathname: "/pair" });
    req.method = "POST";
    const handled = await handleCloudPairRoute(req, res);
    expect(handled).toBe(false);
  });

  it("renders a 400 error page when ?token is missing", async () => {
    const harness = fakeRes();
    const req = fakeReq({ pathname: "/pair" });
    await handleCloudPairRoute(req, harness.res);
    expect(harness.status()).toBe(400);
    expect(harness.body()).toContain("Missing pairing token");
    expect(harness.headers()["content-type"]).toContain("text/html");
    expect(harness.headers()["cache-control"]).toContain("no-store");
  });

  it("keeps staging recovery links in the staging Cloud app", async () => {
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app/api/v1";
    const harness = fakeRes();
    const req = fakeReq({ pathname: "/pair" });

    await handleCloudPairRoute(req, harness.res);

    expect(harness.status()).toBe(400);
    expect(harness.body()).toContain(
      'href="https://cloud-staging.eliza.app/cloud/agents"',
    );
    expect(harness.body()).not.toContain(
      'href="https://cloud.eliza.app/cloud/agents"',
    );
  });

  it("maps legacy staging API configuration to the staging Cloud app", async () => {
    process.env.NEXT_PUBLIC_API_URL =
      "https://api-staging.elizacloud.ai/api/v1";
    const harness = fakeRes();
    const req = fakeReq({ pathname: "/pair" });

    await handleCloudPairRoute(req, harness.res);

    expect(harness.body()).toContain(
      'href="https://cloud-staging.eliza.app/cloud/agents"',
    );
  });

  it("renders 403 when cloud-api rejects the token (expired/used)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Invalid or expired pairing code" }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      ),
    ) as unknown as typeof globalThis.fetch;

    const harness = fakeRes();
    const req = fakeReq({ pathname: "/pair", search: "?token=abc" });
    await handleCloudPairRoute(req, harness.res);
    expect(harness.status()).toBe(403);
    expect(harness.body()).toContain("Sign-in link expired");
  });

  it("renders 503 when cloud-api is unreachable", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        new Error("ECONNREFUSED"),
      ) as unknown as typeof globalThis.fetch;

    const harness = fakeRes();
    const req = fakeReq({ pathname: "/pair", search: "?token=abc" });
    await handleCloudPairRoute(req, harness.res);
    expect(harness.status()).toBe(503);
    expect(harness.body()).toContain("Eliza Cloud is unreachable");
  });

  it("renders 502 when cloud-api omits the bearer or authoritative agent id", async () => {
    for (const body of [
      { apiKey: null, agentId: AGENT_ID },
      { apiKey: "agent_secret_value" },
      { apiKey: "agent_secret_value", agentId: "not-an-agent" },
    ]) {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as typeof globalThis.fetch;

      const harness = fakeRes();
      const req = fakeReq({ pathname: "/pair", search: "?token=abc" });
      await handleCloudPairRoute(req, harness.res);
      expect(harness.status()).toBe(502);
      expect(harness.body()).toContain("Sign-in failed");
      expect(harness.body()).not.toContain('window.location.replace("/")');
    }
  });

  it("forwards the loopback origin and platform agent identity to cloud-api", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = vi.fn((url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            apiKey: "agent_abc",
            agentId: AGENT_ID,
            agentName: "n",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    }) as unknown as typeof globalThis.fetch;

    const harness = fakeRes();
    const req = fakeReq({
      pathname: "/pair",
      search: "?token=abc",
      host: "127.0.0.1:43123",
      proto: "http",
    });
    await handleCloudPairRoute(req, harness.res);
    expect(harness.status()).toBe(200);
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers.origin).toBe("http://127.0.0.1:43123");
    expect(seen.init?.body).toBe(
      JSON.stringify({ token: "abc", agentId: AGENT_ID }),
    );
  });

  it("never exchanges managed requests that reach the container directly", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const req = fakeReq({
      pathname: "/pair",
      search: "?token=abc",
      host: "eliza-staging-1.elizacloud.ai",
      proto: "https",
      ip: "203.0.113.10",
    });
    req.headers["x-forwarded-host"] = "attacker.example";
    const harness = fakeRes();
    await handleCloudPairRoute(req, harness.res);

    expect(harness.status()).toBe(421);
    expect(harness.body()).toContain("Open this agent from Eliza Cloud");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never exchanges for a remote peer spoofing a loopback forwarded host (W5-014)", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    // Before the fix, X-Forwarded-Host/Host were trusted for the loopback
    // gate, so this exact request passed it: a remote peer presenting a
    // loopback-looking origin could redeem a held pairing token through the
    // relay and receive the minted agent apiKey in the handoff HTML.
    const req = fakeReq({
      pathname: "/pair",
      search: "?token=abc",
      host: "localhost:43123",
      ip: "203.0.113.10",
    });
    req.headers["x-forwarded-host"] = "localhost";
    req.headers["x-forwarded-proto"] = "http";
    const harness = fakeRes();
    await handleCloudPairRoute(req, harness.res);

    expect(harness.status()).toBe(421);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows the explicit local-provider relay only for loopback or allowlisted peers", async () => {
    // Each invocation gets a fresh Response — a single shared Response body
    // would be consumed on the first .json() and later calls would 502.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            apiKey: "agent_secret_value",
            agentId: AGENT_ID,
            agentName: "Local",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const loopbackHarness = fakeRes();
    await handleCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=abc",
        host: "127.0.0.1:43123",
        proto: "http",
      }),
      loopbackHarness.res,
    );
    expect(loopbackHarness.status()).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.eliza.app/api/auth/pair",
      expect.objectContaining({
        headers: expect.objectContaining({
          origin: "http://127.0.0.1:43123",
        }),
        body: JSON.stringify({ token: "abc", agentId: AGENT_ID }),
      }),
    );

    // The exchange origin is built from direct request metadata only:
    // forwarded headers must not rewrite it (W5-014).
    fetchMock.mockClear();
    const forwardedHarness = fakeRes();
    const forwardedReq = fakeReq({
      pathname: "/pair",
      search: "?token=abc",
      host: "127.0.0.1:43123",
      proto: "http",
    });
    forwardedReq.headers["x-forwarded-host"] = "attacker.example";
    await handleCloudPairRoute(forwardedReq, forwardedHarness.res);
    expect(forwardedHarness.status()).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.eliza.app/api/auth/pair",
      expect.objectContaining({
        headers: expect.objectContaining({
          origin: "http://127.0.0.1:43123",
        }),
      }),
    );

    // A public peer is rejected no matter what origin metadata it presents.
    fetchMock.mockClear();
    const publicHarness = fakeRes();
    await handleCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=abc",
        host: "agent.example",
        proto: "https",
        ip: "203.0.113.10",
      }),
      publicHarness.res,
    );
    expect(publicHarness.status()).toBe(421);
    expect(fetchMock).not.toHaveBeenCalled();

    // W5-016: the local-Docker bridge gateway is admitted only through the
    // explicit CIDR allowlist; other private-range peers stay rejected.
    fetchMock.mockClear();
    const dockerDefaultHarness = fakeRes();
    await handleCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=abc",
        host: "127.0.0.1:43123",
        proto: "http",
        ip: "172.17.0.1",
      }),
      dockerDefaultHarness.res,
    );
    expect(dockerDefaultHarness.status()).toBe(421);
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS = "172.17.0.0/16";
    try {
      fetchMock.mockClear();
      const dockerHarness = fakeRes();
      await handleCloudPairRoute(
        fakeReq({
          pathname: "/pair",
          search: "?token=abc",
          host: "127.0.0.1:43123",
          proto: "http",
          ip: "172.17.0.1",
        }),
        dockerHarness.res,
      );
      expect(dockerHarness.status()).toBe(200);
      expect(fetchMock).toHaveBeenCalled();

      fetchMock.mockClear();
      const lanHarness = fakeRes();
      await handleCloudPairRoute(
        fakeReq({
          pathname: "/pair",
          search: "?token=abc",
          host: "127.0.0.1:43123",
          proto: "http",
          ip: "192.168.1.10",
        }),
        lanHarness.res,
      );
      expect(lanHarness.status()).toBe(421);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS;
    }
  });

  it("fails before exchange when the local platform identity is missing", async () => {
    delete process.env.ELIZA_CLOUD_AGENT_ID;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const harness = fakeRes();
    await handleCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=abc" }),
      harness.res,
    );

    expect(harness.status()).toBe(503);
    expect(harness.body()).toContain("Agent identity unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders happy-path HTML with the apiKey stored durably and pinned on window globals", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          apiKey: "agent_secret_value",
          agentId: AGENT_ID,
          agentName: "Nova",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;

    const harness = fakeRes();
    const req = fakeReq({ pathname: "/pair", search: "?token=abc" });
    await handleCloudPairRoute(req, harness.res);
    expect(harness.status()).toBe(200);
    const body = harness.body();
    const handoff = executeHandoffHtml(body);
    const scopedKey = cloudPairTokenKeyForAgent(AGENT_ID);
    expect(handoff.sessionValues.get(scopedKey)).toBe("agent_secret_value");
    expect(handoff.localValues.get(scopedKey)).toBe("agent_secret_value");
    expect(handoff.sessionValues.has(CLOUD_PAIR_LEGACY_STORAGE_KEY)).toBe(
      false,
    );
    expect(handoff.localValues.has(CLOUD_PAIR_LEGACY_STORAGE_KEY)).toBe(false);
    expect(handoff.sessionValues.get(CLOUD_PAIR_LOCAL_OWNER_HINT_KEY)).toBe(
      AGENT_ID,
    );
    expect(handoff.localValues.get(CLOUD_PAIR_LOCAL_OWNER_HINT_KEY)).toBe(
      AGENT_ID,
    );
    expect(handoff.windowObject.__ELIZAOS_APP_BOOT_CONFIG__).toEqual({
      apiToken: "agent_secret_value",
    });
    expect(handoff.windowObject.__ELIZA_APP_BOOT_CONFIG__).toEqual({
      apiToken: "agent_secret_value",
    });
    const bootSlot = Object.getOwnPropertySymbols(handoff.windowObject).find(
      (symbol) => symbol.description === "elizaos.app.boot-config",
    );
    expect(bootSlot).toBeDefined();
    expect(bootSlot ? handoff.windowObject[bootSlot] : undefined).toEqual({
      current: { apiToken: "agent_secret_value" },
    });
    expect(handoff.replace).toHaveBeenCalledWith("/");
    expect(body).not.toContain("__ELIZAOS_API_TOKEN__");
    expect(body).not.toContain("__ELIZA_API_TOKEN__");
    expect(harness.headers()["cache-control"]).toContain("no-store");
    expect(harness.headers()["x-frame-options"]).toBe("DENY");
    expect(harness.headers()["content-security-policy"]).toContain(
      "default-src 'none'",
    );
  });

  it("emits a fail-visible handoff branch (console.error + message, guarded redirect) rather than a silent redirect on failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          apiKey: "agent_secret_value",
          agentId: AGENT_ID,
          agentName: "Nova",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;

    const harness = fakeRes();
    const req = fakeReq({ pathname: "/pair", search: "?token=abc" });
    await handleCloudPairRoute(req, harness.res);
    const body = harness.body();

    // The catch is no longer empty: it logs and shows a visible failure.
    expect(body).not.toMatch(/catch\s*\(e\)\s*\{\s*\}/);
    expect(body).toContain("console.error(");
    expect(body).toContain("Pairing failed.");
    // The redirect is guarded behind an early return in the catch, so a failed
    // handoff no longer lands the user at "/" unpaired.
    const catchStart = body.search(/catch\s*\([^)]*\)/);
    const redirectPos = body.indexOf('window.location.replace("/")');
    const returnPos = body.indexOf("return;", catchStart);
    expect(catchStart).toBeGreaterThanOrEqual(0);
    expect(returnPos).toBeGreaterThan(catchStart);
    expect(returnPos).toBeLessThan(redirectPos);
  });

  it("safely escapes an apiKey containing </script>", async () => {
    const evilToken = `agent_a"</script><script>alert(1)</script>`;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          apiKey: evilToken,
          agentId: AGENT_ID,
          agentName: "x",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    ) as unknown as typeof globalThis.fetch;

    const harness = fakeRes();
    const req = fakeReq({ pathname: "/pair", search: "?token=abc" });
    await handleCloudPairRoute(req, harness.res);
    expect(harness.status()).toBe(200);
    const body = harness.body();
    // The inline script must close exactly ONCE — meaning a payload
    // containing `</script>` must be escaped (we use the `<` Unicode
    // escape) so it does NOT terminate the script early.
    const closes = body.match(/<\/script>/g) ?? [];
    expect(closes.length).toBe(1);
    // And the original raw `</script>` must NOT appear in the body anywhere
    // outside of the single legitimate closer.
    const bodyWithoutCloser = body.replace(/<\/script>/, "");
    expect(bodyWithoutCloser).not.toMatch(/<\/script>/);
    const handoff = executeHandoffHtml(body);
    expect(handoff.localValues.get(cloudPairTokenKeyForAgent(AGENT_ID))).toBe(
      evilToken,
    );
  });

  it("rate-limits the same IP after the bucket fills", async () => {
    // Each invocation gets a fresh Response — a single shared Response
    // body would be consumed on the first .json() and subsequent calls
    // would 502 because the parsed body is null.
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            apiKey: "agent_k",
            agentId: AGENT_ID,
            agentName: "n",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    ) as unknown as typeof globalThis.fetch;

    // Bucket size is 5/min from sensitive-rate-limit.ts. Hit it 5 times +
    // assert the 6th call returns 429. A loopback peer is required now that
    // the relay gate keys on the TCP peer (W5-014).
    for (let i = 0; i < 5; i++) {
      const h = fakeRes();
      const r = fakeReq({
        pathname: "/pair",
        search: "?token=abc",
        ip: "127.0.0.2",
      });
      await handleCloudPairRoute(r, h.res);
      expect(h.status()).toBe(200);
    }
    const h6 = fakeRes();
    const r6 = fakeReq({
      pathname: "/pair",
      search: "?token=abc",
      ip: "127.0.0.2",
    });
    await handleCloudPairRoute(r6, h6.res);
    expect(h6.status()).toBe(429);
    expect(h6.body()).toContain("Too many sign-in attempts");
  });
});
