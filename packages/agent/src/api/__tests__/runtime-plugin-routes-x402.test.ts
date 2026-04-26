import type { ServerResponse } from "node:http";
import http from "node:http";
import type { AgentRuntime, Route } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyPaymentProtection,
  isRoutePaymentWrapped,
} from "../../middleware/x402/payment-wrapper.ts";
import { readJsonBody } from "../http-helpers.ts";
import { tryHandleRuntimePluginRoute } from "../runtime-plugin-routes.ts";

function captureResponseBody(res: ServerResponse): { text: Promise<string> } {
  const chunks: string[] = [];
  let resolveText!: (value: string) => void;
  const text = new Promise<string>((resolve) => {
    resolveText = resolve;
  });
  const origEnd = res.end.bind(res);
  (res as ServerResponse & { end: typeof res.end }).end = function (
    this: ServerResponse,
    chunk?: unknown,
    encoding?: unknown,
    cb?: unknown,
  ) {
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
      chunks.push(String(chunk));
    }
    resolveText(chunks.join(""));
    return (origEnd as (this: ServerResponse, ...a: unknown[]) => void).call(
      this,
      chunk as never,
      encoding as never,
      cb as never,
    );
  };
  return { text };
}

describe("tryHandleRuntimePluginRoute + x402", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses JSON request bodies before dispatching plugin routes", async () => {
    const routes: Route[] = [
      {
        type: "POST",
        path: "/demo/body",
        public: true,
        handler: async (req, res) => {
          res.status(200).json({
            body: req.body,
          });
        },
      } as Route,
    ];

    const runtime = {
      routes,
      character: {},
      agentId: "00000000-0000-0000-0000-000000000001",
      getSetting: () => undefined,
      emitEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentRuntime;

    const payload = JSON.stringify({ channelIds: ["123"] });
    const req = new http.IncomingMessage();
    req.method = "POST";
    req.url = "/demo/body";
    req.headers = {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
    };
    req.push(payload);
    req.push(null);

    const res = new http.ServerResponse(req);
    const { text: bodyText } = captureResponseBody(res);

    const url = new URL("http://127.0.0.1/demo/body");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: "POST",
      pathname: "/demo/body",
      url,
      runtime,
      isAuthorized: () => true,
    });

    expect(handled).toBe(true);
    const body = JSON.parse(await bodyText) as {
      body: { channelIds?: string[] };
    };
    expect(body.body.channelIds).toEqual(["123"]);
  });

  it("keeps parsed JSON available to plugin routes that call readJsonBody", async () => {
    const routes: Route[] = [
      {
        type: "POST",
        path: "/demo/body-helper",
        public: true,
        handler: async (req, res) => {
          const body = await readJsonBody(
            req as http.IncomingMessage,
            res as ServerResponse,
          );
          res.status(200).json({ body });
        },
      } as Route,
    ];

    const runtime = {
      routes,
      character: {},
      agentId: "00000000-0000-0000-0000-000000000001",
      getSetting: () => undefined,
      emitEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentRuntime;

    const payload = JSON.stringify({ side: "owner" });
    const req = new http.IncomingMessage();
    req.method = "POST";
    req.url = "/demo/body-helper";
    req.headers = {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
    };
    req.push(payload);
    req.push(null);

    const res = new http.ServerResponse(req);
    const { text: bodyText } = captureResponseBody(res);

    const url = new URL("http://127.0.0.1/demo/body-helper");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: "POST",
      pathname: "/demo/body-helper",
      url,
      runtime,
      isAuthorized: () => true,
    });

    expect(handled).toBe(true);
    const response = JSON.parse(await bodyText) as {
      body: { side?: string };
    };
    expect(response.body.side).toBe("owner");
  });

  it("returns 402 JSON when route has x402 and no payment proof", async () => {
    vi.stubEnv("X402_TEST_MODE", "");

    const routes: Route[] = [
      {
        type: "GET",
        path: "/demo/paid",
        public: true,
        name: "paid",
        description: "Premium demo endpoint",
        x402: {
          priceInCents: 100,
          paymentConfigs: ["base_usdc"],
        },
        handler: async (_req, res) => {
          res.status(200).json({ ok: true });
        },
      } as Route,
    ];

    const runtime = {
      routes,
      character: {},
      agentId: "00000000-0000-0000-0000-000000000001",
      getSetting: () => undefined,
      emitEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentRuntime;

    const req = new http.IncomingMessage();
    req.method = "GET";
    req.url = "/demo/paid";
    req.headers = {};

    const res = new http.ServerResponse(req);
    const { text: bodyText } = captureResponseBody(res);

    const url = new URL("http://127.0.0.1/demo/paid");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: "GET",
      pathname: "/demo/paid",
      url,
      runtime,
      isAuthorized: () => true,
    });

    expect(handled).toBe(true);
    const raw = await bodyText;
    expect(res.statusCode).toBe(402);
    const body = JSON.parse(raw) as {
      x402Version: number;
      accepts: Array<{ description?: string; maxAmountRequired?: string }>;
    };
    expect(body.x402Version).toBe(1);
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts[0]?.description).toBe("Premium demo endpoint");
    expect(body.accepts[0]?.maxAmountRequired).toBe("1000000");
    const paymentRequiredHeader = res.getHeader("PAYMENT-REQUIRED");
    expect(typeof paymentRequiredHeader).toBe("string");
    const paymentRequired = JSON.parse(
      Buffer.from(String(paymentRequiredHeader), "base64").toString("utf8"),
    ) as {
      x402Version: number;
      accepts: Array<{
        network?: string;
        asset?: string;
        maxAmountRequired?: string;
      }>;
    };
    expect(paymentRequired.x402Version).toBe(2);
    expect(paymentRequired.accepts[0]).toMatchObject({
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      maxAmountRequired: "1000000",
    });
    expect(runtime.emitEvent).toHaveBeenCalledWith(
      "PAYMENT_REQUIRED",
      expect.objectContaining({
        path: "/demo/paid",
        configNames: ["base_usdc"],
      }),
    );
  });

  it("skips verification when X402_TEST_MODE is set", async () => {
    vi.stubEnv("X402_TEST_MODE", "true");

    const routes: Route[] = [
      {
        type: "GET",
        path: "/demo/free-in-test",
        public: true,
        x402: {
          priceInCents: 100,
          paymentConfigs: ["base_usdc"],
        },
        handler: async (_req, res) => {
          res.status(200).json({ ok: true });
        },
      } as Route,
    ];

    const runtime = {
      routes,
      character: {},
      agentId: "00000000-0000-0000-0000-000000000001",
      getSetting: () => undefined,
      emitEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentRuntime;

    const req = new http.IncomingMessage();
    req.method = "GET";
    req.url = "/demo/free-in-test";
    req.headers = {};

    const res = new http.ServerResponse(req);
    const { text: bodyText } = captureResponseBody(res);

    const url = new URL("http://127.0.0.1/demo/free-in-test");
    await tryHandleRuntimePluginRoute({
      req,
      res,
      method: "GET",
      pathname: "/demo/free-in-test",
      url,
      runtime,
      isAuthorized: () => true,
    });

    const raw = await bodyText;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(raw)).toEqual({ ok: true });
  });

  it("accepts standard PAYMENT-SIGNATURE after facilitator verify and settle", async () => {
    vi.stubEnv("X402_TEST_MODE", "");
    vi.stubEnv("X402_REPLAY_DURABLE", "0");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ isValid: true, payer: "0xpayer" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            transaction: "0xtx",
            payer: "0xpayer",
            network: "eip155:8453",
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const routes: Route[] = [
      {
        type: "GET",
        path: "/demo/paid-standard",
        public: true,
        x402: {
          priceInCents: 100,
          paymentConfigs: ["base_usdc"],
        },
        handler: async (_req, res) => {
          res.status(200).json({ ok: true });
        },
      } as Route,
    ];
    const runtime = {
      routes,
      character: {},
      agentId: "00000000-0000-0000-0000-000000000001",
      getSetting: () => undefined,
      emitEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentRuntime;
    const paymentPayload = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "1000000",
        payTo: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
      },
      payload: {
        signature: "0xsig-standard-runtime",
        authorization: {
          from: "0xpayer",
          to: "0x066E94e1200aa765d0A6392777D543Aa6Dea606C",
          value: "1000000",
          validBefore: "9999999999",
          nonce:
            "0x0000000000000000000000000000000000000000000000000000000000000042",
        },
      },
    };

    const req = new http.IncomingMessage();
    req.method = "GET";
    req.url = "/demo/paid-standard";
    req.headers = {
      "payment-signature": Buffer.from(
        JSON.stringify(paymentPayload),
        "utf8",
      ).toString("base64"),
    };

    const res = new http.ServerResponse(req);
    const { text: bodyText } = captureResponseBody(res);

    await tryHandleRuntimePluginRoute({
      req,
      res,
      method: "GET",
      pathname: "/demo/paid-standard",
      url: new URL("http://127.0.0.1/demo/paid-standard"),
      runtime,
      isAuthorized: () => true,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(await bodyText)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://x402.elizaos.ai/api/v1/x402/verify",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://x402.elizaos.ai/api/v1/x402/settle",
    );
    const paymentResponseHeader = res.getHeader("PAYMENT-RESPONSE");
    expect(typeof paymentResponseHeader).toBe("string");
    expect(
      JSON.parse(
        Buffer.from(String(paymentResponseHeader), "base64").toString("utf8"),
      ),
    ).toMatchObject({ success: true, transaction: "0xtx" });

    vi.unstubAllGlobals();
  });

  it("dispatches applyPaymentProtection routes without double-wrapping (marker)", async () => {
    vi.stubEnv("X402_TEST_MODE", "true");

    const rawRoutes: Route[] = [
      {
        type: "GET",
        path: "/demo/pre-wrapped",
        public: true,
        x402: {
          priceInCents: 100,
          paymentConfigs: ["base_usdc"],
        },
        handler: async (_req, res) => {
          res.status(200).json({ ok: true });
        },
      } as Route,
    ];

    const routes = applyPaymentProtection(rawRoutes);
    expect(isRoutePaymentWrapped(routes[0])).toBe(true);

    const runtime = {
      routes,
      character: {},
      agentId: "00000000-0000-0000-0000-000000000001",
      getSetting: () => undefined,
      emitEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentRuntime;

    const req = new http.IncomingMessage();
    req.method = "GET";
    req.url = "/demo/pre-wrapped";
    req.headers = {};

    const res = new http.ServerResponse(req);
    const { text: bodyText } = captureResponseBody(res);

    const url = new URL("http://127.0.0.1/demo/pre-wrapped");
    await tryHandleRuntimePluginRoute({
      req,
      res,
      method: "GET",
      pathname: "/demo/pre-wrapped",
      url,
      runtime,
      isAuthorized: () => true,
    });

    const raw = await bodyText;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(raw)).toEqual({ ok: true });
  });
});
