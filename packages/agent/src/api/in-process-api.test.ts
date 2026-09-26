import type { IAgentRuntime } from "@elizaos/core";
import { registerHttpPluginRoutes } from "@elizaos/core/api/http-plugin-runtime";
import { expect, it } from "vitest";
import { buildLegacyShim, capturedToResult } from "./dispatch-route";
import { tryHandleHonoRuntimeRoute } from "./hono-mount";
import { dispatchApiRoute, registerInProcessApi } from "./in-process-api";
import type { RouteKernel } from "./route-kernel";

function fixture() {
  const runtime = {} as IAgentRuntime;
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
  return { runtime, kernel };
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
