import http from "node:http";
import { Socket } from "node:net";
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
    host: opts.host ?? "agent-123.elizacloud.ai",
    ...(opts.proto ? { "x-forwarded-proto": opts.proto } : {}),
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: opts.ip ?? "203.0.113.10",
    configurable: true,
  });
  return req;
}

const originalFetch = globalThis.fetch;

const originalCloudBaseUrl = process.env.ELIZAOS_CLOUD_BASE_URL;

beforeEach(() => {
  __resetCloudPairRateLimitForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  // The console-link cases pin the agent's environment; leaking that would
  // silently retarget every later case's recovery link.
  if (originalCloudBaseUrl === undefined) {
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
  } else {
    process.env.ELIZAOS_CLOUD_BASE_URL = originalCloudBaseUrl;
  }
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
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ apiKey: "agent_secret_value", agentName: "Nova" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const harness = fakeRes();
    const handled = await handleStandaloneCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=pair-token",
        host: "agent-123.elizacloud.ai",
        proto: "https",
      }),
      harness.res,
    );

    expect(handled).toBe(true);
    expect(harness.status()).toBe(200);
    expect(harness.headers()["cache-control"]).toContain("no-store");
    expect(harness.headers()["x-frame-options"]).toBe("DENY");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.elizacloud.ai/api/auth/pair",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          origin: "https://agent-123.elizacloud.ai",
        }),
        body: JSON.stringify({ token: "pair-token" }),
      }),
    );
    expect(harness.body()).toContain("persist(window.sessionStorage)");
    expect(harness.body()).toContain("persist(window.localStorage)");
    expect(harness.body()).toContain(
      'throw new Error("No browser storage accepted the paired token.")',
    );
    expect(harness.body()).toContain("apiToken: key");
    expect(harness.body()).toContain('window.location.replace("/")');
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

  it("does not redirect on expired or rejected pairing links", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=expired" }),
      harness.res,
    );

    expect(harness.status()).toBe(403);
    expect(harness.body()).toContain("Sign-in link could not be verified");
    expect(harness.body()).not.toContain('window.location.replace("/")');
  });

  it("does not assert expiry for a rejection Cloud never attributed to expiry", async () => {
    // Cloud returns the same opaque body for expired / unknown / origin-bound /
    // cross-environment rejections. #18178 was a FRESH token rejected here, and
    // the "expired" copy sent the reporter chasing the wrong cause.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 403 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=fresh-but-rejected" }),
      harness.res,
    );

    expect(harness.status()).toBe(403);
    expect(harness.body()).not.toContain("Sign-in link expired");
    expect(harness.body()).toContain("did not accept this sign-in link");
  });

  it("points the recovery link at the console for the agent's OWN environment", async () => {
    // A staging agent linking users at the production console is a dead end:
    // the account, org, and agent all live in the staging deployment.
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
      fakeReq({
        pathname: "/pair",
        search: "?token=expired",
        host: "agent-123.staging.elizacloud.ai",
      }),
      harness.res,
    );

    expect(harness.body()).toContain(
      'href="https://staging.elizacloud.ai/dashboard/agents"',
    );
    expect(harness.body()).not.toContain("www.elizacloud.ai");
  });

  it("keeps the production console link for a production agent", async () => {
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.elizacloud.ai/api/v1";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=expired" }),
      harness.res,
    );

    expect(harness.body()).toContain(
      'href="https://www.elizacloud.ai/dashboard/agents"',
    );
  });

  // The configured base URL is untrusted input rendered into an href, and
  // parseability is not a safety property. A scriptable or non-web scheme must
  // never become the link at all.
  it.each([
    ["a non-web scheme", "javascript:alert(1)//"],
    ["a data URL", "data:text/html,<script>alert(1)</script>"],
    ["a file URL", "file:///etc/passwd"],
    ["quote-bearing input", 'https://evil.example"><script>alert(1)</script>'],
    ["a non-loopback http origin", "http://evil.example"],
  ])("refuses %s and falls back to a known-safe console", async (_n, raw) => {
    process.env.ELIZAOS_CLOUD_BASE_URL = raw;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=expired" }),
      harness.res,
    );

    const body = harness.body();
    expect(/<a href="([^"]*)"/.exec(body)?.[1]).toBe(
      "https://www.elizacloud.ai/dashboard/agents",
    );
    expect(body).not.toContain("javascript:");
    expect(body).not.toContain("data:text/html");
    expect(body).not.toContain("file://");
    expect(body).not.toContain("evil.example");
    expect(body).not.toContain("<script>");
  });

  // A self-hosted https console IS a legitimate target, so the guarantee there
  // is canonicalization: credentials, path, query, and fragment never survive
  // into the attribute.
  it.each([
    ["embedded credentials", "https://console.example.test"],
    ["path, query and fragment", "https://console.example.test"],
  ])("strips %s down to a canonical origin", async (label, expectedOrigin) => {
    process.env.ELIZAOS_CLOUD_BASE_URL = label.startsWith("embedded")
      ? "https://user:pass@console.example.test"
      : "https://console.example.test/x?y=1#z";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=expired" }),
      harness.res,
    );

    const body = harness.body();
    expect(/<a href="([^"]*)"/.exec(body)?.[1]).toBe(
      `${expectedOrigin}/dashboard/agents`,
    );
    expect(body).not.toContain("user:pass");
    expect(body).not.toContain("y=1");
  });

  // The allowlist is keyed by a parsed hostname, so an inherited member name
  // must not be mistaken for a configured mapping and skip canonicalization.
  it.each([["constructor"], ["__proto__"]])(
    "does not treat the inherited key %s as an allowlisted console host",
    async (hostname) => {
      process.env.ELIZAOS_CLOUD_BASE_URL = `https://${hostname}/api/v1`;
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
      );

      const harness = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({ pathname: "/pair", search: "?token=expired" }),
        harness.res,
      );

      expect(/<a href="([^"]*)"/.exec(harness.body())?.[1]).toBe(
        `https://${hostname}/dashboard/agents`,
      );
    },
  );

  it("serves a loopback console link for a self-hosted http deployment", async () => {
    process.env.ELIZAOS_CLOUD_BASE_URL = "http://localhost:3000/api/v1";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=expired" }),
      harness.res,
    );

    expect(harness.body()).toContain(
      'href="http://localhost:3000/dashboard/agents"',
    );
  });

  it("emits exactly one structured rejection log, with no pairing token in it", async () => {
    const { logger } = await import("@elizaos/core");
    vi.mocked(logger.warn).mockClear();
    process.env.ELIZAOS_CLOUD_BASE_URL =
      "https://api-staging.elizacloud.ai/api/v1";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 403 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=super-secret-pairing-token",
        host: "agent-123.staging.elizacloud.ai",
        proto: "https",
      }),
      harness.res,
    );

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    // Context-first, message-second: the @elizaos/core logger signature.
    const [context, message] = vi.mocked(logger.warn).mock
      .calls[0] as unknown as [Record<string, unknown>, string];
    expect(message).toContain("[cloud-pair]");
    expect(context).toMatchObject({
      status: 403,
      exchangeUrl: "https://api-staging.elizacloud.ai/api/auth/pair",
      requestOrigin: "https://agent-123.staging.elizacloud.ai",
    });
    // The pairing token is a single-use credential; it must never be logged.
    expect(JSON.stringify({ message, context })).not.toContain(
      "super-secret-pairing-token",
    );
  });
});
