/**
 * Exercises `handleCloudPairRoute` — the `/pair` HTTP handler that redeems a
 * cloud pairing token against the cloud API and returns an HTML handoff page
 * that stores the returned apiKey in sessionStorage. Drives real
 * http.IncomingMessage/ServerResponse fakes and stubs `globalThis.fetch` to
 * simulate the cloud API; covers the missing-token, expired, unreachable, no-key,
 * XSS-escaping, origin-forwarding, and per-IP rate-limit branches.
 */
import * as http from "node:http";
import { Socket } from "node:net";
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

vi.mock("@elizaos/core", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

let handleCloudPairRoute: typeof import("./cloud-pair-route").handleCloudPairRoute;

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
    host: opts.host ?? "203.0.113.10:21363",
    ...(opts.proto ? { "x-forwarded-proto": opts.proto } : {}),
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: opts.ip ?? "203.0.113.50",
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
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
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

  it("renders 502 when cloud-api returns 2xx but no apiKey", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ apiKey: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const harness = fakeRes();
    const req = fakeReq({ pathname: "/pair", search: "?token=abc" });
    await handleCloudPairRoute(req, harness.res);
    expect(harness.status()).toBe(502);
    expect(harness.body()).toContain("Sign-in failed");
  });

  it("forwards origin to cloud-api derived from x-forwarded headers", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = vi.fn((url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return Promise.resolve(
        new Response(JSON.stringify({ apiKey: "agent_abc", agentName: "n" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof globalThis.fetch;

    const harness = fakeRes();
    const req = fakeReq({
      pathname: "/pair",
      search: "?token=abc",
      host: "203.0.113.10:21363",
      proto: "https",
    });
    await handleCloudPairRoute(req, harness.res);
    expect(harness.status()).toBe(200);
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers.origin).toBe("https://203.0.113.10:21363");
  });

  it("renders happy-path HTML with the apiKey stored in sessionStorage and pinned on window globals", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ apiKey: "agent_secret_value", agentName: "Nova" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ) as unknown as typeof globalThis.fetch;

    const harness = fakeRes();
    const req = fakeReq({ pathname: "/pair", search: "?token=abc" });
    await handleCloudPairRoute(req, harness.res);
    expect(harness.status()).toBe(200);
    const body = harness.body();
    expect(body).toContain('"agent_secret_value"');
    expect(body).toContain(
      'window.sessionStorage.setItem("eliza:cloud-pair:api-token", key)',
    );
    expect(body).toContain('Symbol.for("elizaos.app.boot-config")');
    expect(body).toContain("apiToken: key");
    expect(body).not.toContain("__ELIZAOS_API_TOKEN__");
    expect(body).not.toContain("__ELIZA_API_TOKEN__");
    expect(body).toContain('window.location.replace("/")');
    expect(harness.headers()["cache-control"]).toContain("no-store");
    expect(harness.headers()["x-frame-options"]).toBe("DENY");
  });

  it("emits a fail-visible handoff branch (console.error + message, guarded redirect) rather than a silent redirect on failure", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ apiKey: "agent_secret_value", agentName: "Nova" }),
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
    const catchStart = body.indexOf("catch (e)");
    const redirectPos = body.indexOf('window.location.replace("/")');
    const returnPos = body.indexOf("return;", catchStart);
    expect(catchStart).toBeGreaterThanOrEqual(0);
    expect(returnPos).toBeGreaterThan(catchStart);
    expect(returnPos).toBeLessThan(redirectPos);
  });

  it("safely escapes an apiKey containing </script>", async () => {
    const evilToken = `agent_a"</script><script>alert(1)</script>`;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ apiKey: evilToken, agentName: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
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
  });

  it("rate-limits the same IP after the bucket fills", async () => {
    // Each invocation gets a fresh Response — a single shared Response
    // body would be consumed on the first .json() and subsequent calls
    // would 502 because the parsed body is null.
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ apiKey: "agent_k", agentName: "n" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof globalThis.fetch;

    // Bucket size is 5/min from sensitive-rate-limit.ts. Hit it 5 times +
    // assert the 6th call returns 429.
    for (let i = 0; i < 5; i++) {
      const h = fakeRes();
      const r = fakeReq({
        pathname: "/pair",
        search: "?token=abc",
        ip: "9.9.9.9",
      });
      await handleCloudPairRoute(r, h.res);
      expect(h.status()).toBe(200);
    }
    const h6 = fakeRes();
    const r6 = fakeReq({
      pathname: "/pair",
      search: "?token=abc",
      ip: "9.9.9.9",
    });
    await handleCloudPairRoute(r6, h6.res);
    expect(h6.status()).toBe(429);
    expect(h6.body()).toContain("Too many sign-in attempts");
  });
});
