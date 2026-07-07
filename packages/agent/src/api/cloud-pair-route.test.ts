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

beforeEach(() => {
  __resetCloudPairRateLimitForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
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
    expect(harness.body()).toContain(
      'window.sessionStorage.setItem("eliza:cloud-pair:api-token", key)',
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
    expect(harness.body()).toContain("Sign-in link expired");
    expect(harness.body()).not.toContain('window.location.replace("/")');
  });
});
