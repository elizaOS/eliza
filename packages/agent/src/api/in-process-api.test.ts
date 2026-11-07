import type { IAgentRuntime } from "@elizaos/core";
import { registerHttpPluginRoutes } from "@elizaos/host/protocol";
import { expect, it } from "vitest";
import {
  buildLegacyShim,
  capturedToResult,
  dispatchRoute,
} from "./dispatch-route";
import { tryHandleHonoRuntimeRoute } from "./hono-mount";
import { dispatchApiRoute, registerInProcessApi } from "./in-process-api";
import type { RouteKernel } from "./route-kernel";

function fixture() {
  const runtime = {} as IAgentRuntime;
  const served: string[] = [];
  registerHttpPluginRoutes(runtime, {
    name: "native-probe",
    description: "Tests native request provenance",
    routes: [
      {
        type: "POST",
        path: "/api/native-probe",
        rawPath: true,
        routeHandler: async (context) => ({
          status: 200,
          body: {
            inProcess: context.inProcess,
            isTrustedLocal: context.isTrustedLocal,
          },
        }),
      },
      {
        type: "GET",
        path: "/api/paid-legacy",
        rawPath: true,
        x402: true,
        handler: async (_req, res) => {
          served.push("legacy");
          res.json({ paidContent: true });
        },
      },
      {
        type: "GET",
        path: "/api/paid-return-shape",
        rawPath: true,
        x402: true,
        routeHandler: async () => {
          served.push("return-shape");
          return { status: 200, body: { paidContent: true } };
        },
      },
    ],
  });
  const kernel = {
    handle: async (req, res) => {
      await tryHandleHonoRuntimeRoute({
        req,
        res,
        runtime,
        isAuthorized: () => req.headers.authorization === "Bearer native-token",
        isTrustedLocal: () => false,
      });
    },
  } as RouteKernel;
  return { runtime, kernel, served };
}

it("preserves authenticated native provenance across the full kernel and Hono adapter", async () => {
  const { runtime, kernel } = fixture();
  const unregister = registerInProcessApi(runtime, kernel);
  try {
    const result = await dispatchApiRoute({
      runtime,
      method: "POST",
      path: "/api/native-probe",
      headers: { authorization: "Bearer native-token" },
      body: {},
      inProcess: true,
      isAuthorized: () => true,
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ inProcess: true, isTrustedLocal: false });
    const denied = await dispatchApiRoute({
      runtime,
      method: "POST",
      path: "/api/native-probe",
      headers: {},
      body: {},
      inProcess: true,
      isAuthorized: () => true,
    });
    expect(denied.status).toBe(401);
  } finally {
    unregister();
  }
});

it("overwrites an HTTP client's spoofed native-provenance header", async () => {
  const { kernel } = fixture();
  const { req, res, captured } = buildLegacyShim({
    method: "POST",
    path: "/api/native-probe",
    headers: {
      authorization: "Bearer native-token",
      "x-eliza-internal-in-process": "1",
    },
    body: {},
    query: {},
    params: {},
  });
  try {
    await kernel.handle(req, res);
    expect(capturedToResult(captured).body).toEqual({
      inProcess: false,
      isTrustedLocal: false,
    });
  } finally {
    req.destroy();
    req.socket.destroy();
  }
});

it("refuses an x402 route when payment enforcement is unavailable", async () => {
  // `@elizaos/plugin-x402` is an optional peer that is not installed here, so
  // neither handler shape can be payment-gated.
  const { runtime, kernel, served } = fixture();
  const unregister = registerInProcessApi(runtime, kernel);
  try {
    const request = {
      runtime,
      method: "GET",
      headers: { authorization: "Bearer native-token" },
      inProcess: true,
      isAuthorized: () => true,
    };
    const results = [
      // Return-shape routes reach the dispatcher through the kernel and Hono.
      await dispatchApiRoute({ ...request, path: "/api/paid-return-shape" }),
      await dispatchRoute({ ...request, path: "/api/paid-legacy" }),
    ];
    for (const result of results) {
      expect(result?.status).toBe(503);
      expect(result?.body).toMatchObject({
        code: "X402_ENFORCEMENT_UNAVAILABLE",
      });
    }
    expect(served).toEqual([]);
  } finally {
    unregister();
  }
});
