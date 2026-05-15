import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const configMock = vi.hoisted(() => ({
  loadElizaConfig: vi.fn(() => ({})),
}));

vi.mock("@elizaos/plugin-streaming", () => ({}));
vi.mock("../config/config.ts", () => configMock);

import { handleMobileOptionalRoutes } from "./mobile-optional-routes.ts";

function makeRes() {
  const headers = new Map<string, string>();
  let body = "";
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    writeHead(statusCode: number, headerValues?: Record<string, string>) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headerValues ?? {})) {
        headers.set(name.toLowerCase(), value);
      }
    },
    write(chunk?: unknown) {
      if (chunk !== undefined) body += String(chunk);
      return true;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) body += String(chunk);
    },
    json() {
      return JSON.parse(body);
    },
    body() {
      return body;
    },
    header(name: string) {
      return headers.get(name.toLowerCase());
    },
  };
  return res as typeof res & http.ServerResponse;
}

function makeReq(body?: string): http.IncomingMessage {
  return Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
    method: "GET",
    url: "/api/stream/settings",
  }) as unknown as http.IncomingMessage;
}

describe("handleMobileOptionalRoutes", () => {
  const oldEnv = process.env.ELIZA_MOBILE_LOCAL_AGENT;
  const oldBridgeEnv = process.env.ELIZA_DEVICE_BRIDGE_ENABLED;

  afterEach(() => {
    if (oldEnv === undefined) {
      delete process.env.ELIZA_MOBILE_LOCAL_AGENT;
    } else {
      process.env.ELIZA_MOBILE_LOCAL_AGENT = oldEnv;
    }
    if (oldBridgeEnv === undefined) {
      delete process.env.ELIZA_DEVICE_BRIDGE_ENABLED;
    } else {
      process.env.ELIZA_DEVICE_BRIDGE_ENABLED = oldBridgeEnv;
    }
    configMock.loadElizaConfig.mockReturnValue({});
  });

  it("serves stream settings on mobile when the optional streaming plugin is stubbed", async () => {
    process.env.ELIZA_MOBILE_LOCAL_AGENT = "1";
    const res = makeRes();

    const handled = await handleMobileOptionalRoutes(
      makeReq(),
      res,
      "/api/stream/settings",
      "GET",
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.header("content-type")).toBe("application/json");
    expect(res.json()).toEqual({ ok: true, settings: {} });
  });

  it("reports local runtime mode for mobile local agents", async () => {
    process.env.ELIZA_MOBILE_LOCAL_AGENT = "1";
    const res = makeRes();

    const handled = await handleMobileOptionalRoutes(
      makeReq(),
      res,
      "/api/runtime/mode",
      "GET",
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mode: "local",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
  });

  it("does not force local runtime mode for device bridge cloud controllers", async () => {
    delete process.env.ELIZA_MOBILE_LOCAL_AGENT;
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    configMock.loadElizaConfig.mockReturnValue({
      deploymentTarget: { runtime: "cloud" },
    });
    const res = makeRes();

    const handled = await handleMobileOptionalRoutes(
      makeReq(),
      res,
      "/api/runtime/mode",
      "GET",
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mode: "cloud",
      deploymentRuntime: "cloud",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
  });

  it("serves empty computer-use approvals when CUA is not loaded in mobile local mode", async () => {
    process.env.ELIZA_MOBILE_LOCAL_AGENT = "1";
    const res = makeRes();

    const handled = await handleMobileOptionalRoutes(
      makeReq(),
      res,
      "/api/computer-use/approvals",
      "GET",
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mode: "off",
      pendingCount: 0,
      pendingApprovals: [],
    });
  });

  it("keeps the computer-use approval stream alive with an empty snapshot fallback", async () => {
    process.env.ELIZA_MOBILE_LOCAL_AGENT = "1";
    const res = makeRes();

    const handled = await handleMobileOptionalRoutes(
      makeReq(),
      res,
      "/api/computer-use/approvals/stream",
      "GET",
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.header("content-type")).toBe("text/event-stream");
    expect(res.body()).toContain('"type":"snapshot"');
    expect(res.body()).toContain('"mode":"off"');
  });

  it("validates and stores mobile fallback stream settings in-process", async () => {
    process.env.ELIZA_MOBILE_LOCAL_AGENT = "1";
    const postRes = makeRes();

    await handleMobileOptionalRoutes(
      makeReq(
        JSON.stringify({
          settings: {
            avatarIndex: 7,
            voice: { enabled: true, provider: "local-inference" },
          },
        }),
      ),
      postRes,
      "/api/stream/settings",
      "POST",
    );

    expect(postRes.statusCode).toBe(200);
    expect(postRes.json()).toEqual({
      ok: true,
      settings: {
        avatarIndex: 7,
        voice: { enabled: true, provider: "local-inference" },
      },
    });

    const getRes = makeRes();
    await handleMobileOptionalRoutes(
      makeReq(),
      getRes,
      "/api/stream/settings",
      "GET",
    );

    expect(getRes.json()).toEqual(postRes.json());
  });

  it("rejects invalid mobile fallback stream settings", async () => {
    process.env.ELIZA_MOBILE_LOCAL_AGENT = "1";
    const res = makeRes();

    const handled = await handleMobileOptionalRoutes(
      makeReq(JSON.stringify({ settings: { avatarIndex: -1 } })),
      res,
      "/api/stream/settings",
      "POST",
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.body()).toContain("avatarIndex");
  });

  it("rejects unsupported mobile fallback approval modes", async () => {
    process.env.ELIZA_MOBILE_LOCAL_AGENT = "1";
    const res = makeRes();

    const handled = await handleMobileOptionalRoutes(
      makeReq(JSON.stringify({ mode: "manual" })),
      res,
      "/api/computer-use/approval-mode",
      "POST",
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.body()).toContain("approval mode");
  });
});
