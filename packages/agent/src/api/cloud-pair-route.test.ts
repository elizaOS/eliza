/** Exercises the standalone Cloud-pair relay and its executable browser handoff. */

import http from "node:http";
import { Socket } from "node:net";
import { runInNewContext } from "node:vm";
import {
  CLOUD_PAIR_LEGACY_STORAGE_KEY,
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
    location: { replace },
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
    const handoff = executeHandoffHtml(harness.body());
    const scopedKey = cloudPairTokenKeyForAgent(AGENT_ID);
    expect(handoff.sessionValues.get(scopedKey)).toBe("agent_secret_value");
    expect(handoff.localValues.get(scopedKey)).toBe("agent_secret_value");
    expect(handoff.sessionValues.has(CLOUD_PAIR_LEGACY_STORAGE_KEY)).toBe(
      false,
    );
    expect(handoff.localValues.has(CLOUD_PAIR_LEGACY_STORAGE_KEY)).toBe(false);
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
