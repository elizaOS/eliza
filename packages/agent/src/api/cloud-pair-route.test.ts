/** Exercises the standalone Cloud-pair relay and its executable browser handoff. */

import http from "node:http";
import { Socket } from "node:net";
import { runInNewContext } from "node:vm";
import { logger } from "@elizaos/core";
import {
  CLOUD_PAIR_LEGACY_STORAGE_KEY,
  CLOUD_PAIR_LOCAL_OWNER_HINT_KEY,
  cloudPairTokenKeyForAgent,
} from "@elizaos/shared/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCloudPairRateLimitForTests,
  handleStandaloneCloudPairRoute,
} from "./cloud-pair-route.ts";

vi.mock("@elizaos/core", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

interface FakeRes {
  res: http.ServerResponse;
  body(): string;
  status(): number;
  headers(): Record<string, string>;
}

const AGENT_ID = "55555555-5555-4555-8555-555555555555";
const MANAGED_ENV_KEYS = [
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_CLOUD_PAIR_DIRECT_RELAY",
  "ELIZA_CLOUD_AGENT_ID",
  "WAIFU_ELIZA_CLOUD_AGENT_ID",
  "ELIZAOS_CLOUD_BASE_URL",
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
  host?: string;
  proto?: string;
  ip?: string;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = "GET";
  req.url = `${opts.pathname}${opts.search ?? ""}`;
  req.headers = {
    host: opts.host ?? "127.0.0.1:43123",
    ...(opts.proto ? { "x-forwarded-proto": opts.proto } : {}),
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: opts.ip ?? "203.0.113.10",
    configurable: true,
  });
  return req;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  __resetCloudPairRateLimitForTests();
  clearManagedEnv();
  process.env.ELIZA_CLOUD_PROVISIONED = "1";
  process.env.ELIZA_CLOUD_PAIR_DIRECT_RELAY = "1";
  process.env.ELIZA_CLOUD_AGENT_ID = AGENT_ID;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  restoreManagedEnv();
});

describe("handleStandaloneCloudPairRoute", () => {
  it("falls through for non-pair paths", async () => {
    const harness = fakeRes();
    await expect(
      handleStandaloneCloudPairRoute(
        fakeReq({ pathname: "/api/status" }),
        harness.res,
      ),
    ).resolves.toBe(false);
  });

  it("exchanges a one-time token and serves the session handoff HTML", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          apiKey: "agent_secret_value",
          agentId: AGENT_ID,
          agentName: "Nova",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const harness = fakeRes();
    const handled = await handleStandaloneCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=pair-token",
        host: "127.0.0.1:43123",
        proto: "http",
      }),
      harness.res,
    );

    expect(handled).toBe(true);
    expect(harness.status()).toBe(200);
    expect(harness.headers()["cache-control"]).toContain("no-store");
    expect(harness.headers()["x-frame-options"]).toBe("DENY");
    expect(harness.headers()["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.elizacloud.ai/api/auth/pair",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          origin: "http://127.0.0.1:43123",
        }),
        body: JSON.stringify({ token: "pair-token", agentId: AGENT_ID }),
      }),
    );
    const handoff = executeHandoffHtml(harness.body());
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
  });

  it("never exchanges managed requests that reach the container directly", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const req = fakeReq({
      pathname: "/pair",
      search: "?token=pair-token",
      host: "eliza-staging-1.elizacloud.ai",
      proto: "https",
    });
    req.headers["x-forwarded-host"] = "attacker.example";
    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(req, harness.res);

    expect(harness.status()).toBe(421);
    expect(harness.body()).toContain("Open this agent from Eliza Cloud");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows the explicit local-provider relay only for a loopback origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          apiKey: "agent_secret_value",
          agentId: AGENT_ID,
          agentName: "Local",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const loopbackHarness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=pair-token",
        host: "127.0.0.1:43123",
        proto: "http",
      }),
      loopbackHarness.res,
    );
    expect(loopbackHarness.status()).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.elizacloud.ai/api/auth/pair",
      expect.objectContaining({
        headers: expect.objectContaining({ origin: "http://127.0.0.1:43123" }),
        body: JSON.stringify({ token: "pair-token", agentId: AGENT_ID }),
      }),
    );

    fetchMock.mockClear();
    const publicHarness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=pair-token",
        host: "agent.example",
        proto: "https",
      }),
      publicHarness.res,
    );
    expect(publicHarness.status()).toBe(421);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails before exchange when the local platform identity is missing", async () => {
    delete process.env.ELIZA_CLOUD_AGENT_ID;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.status()).toBe(503);
    expect(harness.body()).toContain("Agent identity unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails visibly when the Cloud response omits or corrupts agent ownership", async () => {
    for (const body of [
      { apiKey: "agent_secret_value", agentName: "Nova" },
      {
        apiKey: "agent_secret_value",
        agentId: "not-an-agent",
        agentName: "Nova",
      },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );

      const harness = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
        harness.res,
      );

      expect(harness.status()).toBe(502);
      expect(harness.body()).toContain("Sign-in failed");
      expect(harness.body()).not.toContain('window.location.replace("/")');
    }
  });

  it("escapes script-closing content while preserving the exact bearer", async () => {
    const apiKey = `agent_a"</script><script>alert(1)</script>`;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ apiKey, agentId: AGENT_ID, agentName: "Nova" }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.status()).toBe(200);
    expect(harness.body().match(/<\/script>/g)).toHaveLength(1);
    const handoff = executeHandoffHtml(harness.body());
    expect(handoff.localValues.get(cloudPairTokenKeyForAgent(AGENT_ID))).toBe(
      apiKey,
    );
  });

  it("shows a no-store error page when the token is missing", async () => {
    const harness = fakeRes();
    const handled = await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair" }),
      harness.res,
    );

    expect(handled).toBe(true);
    expect(harness.status()).toBe(400);
    expect(harness.headers()["cache-control"]).toContain("no-store");
    expect(harness.body()).toContain("Missing pairing token");
  });

  it("does not redirect on rejected pairing links and renders honest copy", async () => {
    for (const rejectStatus of [401, 403, 410]) {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({}), { status: rejectStatus }),
          ),
      );

      const harness = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
        harness.res,
      );

      expect(harness.status()).toBe(403);
      expect(harness.body()).toContain("Sign-in link could not be verified");
      // The word "expired" must not appear anywhere — the relay cannot know
      // the cause, so it must not assert it. See issue #18184.
      expect(harness.body().toLowerCase()).not.toContain("expired");
      expect(harness.body()).not.toContain('window.location.replace("/")');
    }
  });

  it("never logs or renders the pairing token on rejection", async () => {
    const secretToken = "super-secret-pair-token-abc123";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: `?token=${secretToken}` }),
      harness.res,
    );

    // Token must not appear in the rendered HTML.
    expect(harness.body()).not.toContain(secretToken);
    // Token must not appear in any logger call.
    for (const call of vi.mocked(logger.warn).mock.calls) {
      expect(call.join(" ")).not.toContain(secretToken);
    }
    for (const call of vi.mocked(logger.error).mock.calls) {
      expect(call.join(" ")).not.toContain(secretToken);
    }
  });

  it("emits exactly one structured warning with status, exchangeUrl, and requestOrigin on rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    vi.mocked(logger.warn).mockClear();

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=pair-token",
        host: "127.0.0.1:43123",
        proto: "http",
      }),
      harness.res,
    );

    // Exactly one warning — not two (no generic non-2xx log for 401/403/410).
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const logLine = String(vi.mocked(logger.warn).mock.calls[0][0]);
    expect(logLine).toContain("pairing link rejected");
    expect(logLine).toContain("status=410");
    expect(logLine).toContain("exchangeUrl=");
    expect(logLine).toContain("requestOrigin=http://127.0.0.1:43123");
  });

  it("resolves the recovery link to the production console by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.body()).toContain(
      "https://www.elizacloud.ai/dashboard/agents",
    );
    expect(harness.body()).not.toContain("staging.elizacloud.ai");
  });

  it("resolves the recovery link to the staging console for a staging-provisioned agent", async () => {
    process.env.ELIZAOS_CLOUD_BASE_URL =
      "https://api-staging.elizacloud.ai/api/v1";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.body()).toContain(
      "https://staging.elizacloud.ai/dashboard/agents",
    );
    expect(harness.body()).not.toContain("www.elizacloud.ai");
  });

  it("resolves the recovery link to staging for wildcard staging hostnames", async () => {
    process.env.ELIZAOS_CLOUD_BASE_URL =
      "https://us-east.staging.elizacloud.ai/api/v1";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.body()).toContain(
      "https://staging.elizacloud.ai/dashboard/agents",
    );
  });

  it("resolves the recovery link to staging for the bare staging apex", async () => {
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://staging.elizacloud.ai/api/v1";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.body()).toContain(
      "https://staging.elizacloud.ai/dashboard/agents",
    );
    expect(harness.body()).not.toContain("www.elizacloud.ai");
  });

  it("resolves the recovery link to staging for the app-staging host", async () => {
    process.env.ELIZAOS_CLOUD_BASE_URL =
      "https://app-staging.elizacloud.ai/api/v1";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.body()).toContain(
      "https://staging.elizacloud.ai/dashboard/agents",
    );
    expect(harness.body()).not.toContain("www.elizacloud.ai");
  });
});
