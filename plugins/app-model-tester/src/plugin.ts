/**
 * Defines `modelTesterPlugin` — the `Plugin` object that mounts the Model Tester
 * dashboard surface: the three probe routes (delegated to `handleModelTesterRoute`)
 * and a single view declaration spanning the GUI, XR, and TUI modalities.
 */

import type http from "node:http";
import type { Plugin, Route, RouteRequest, RouteResponse } from "@elizaos/core";
import { handleModelTesterRoute } from "./routes.js";

type NodeRouteRequest = RouteRequest & http.IncomingMessage;
type NodeRouteResponse = RouteResponse & http.ServerResponse;

function assertHttpIncomingMessage(
  req: RouteRequest,
): asserts req is NodeRouteRequest {
  if (
    typeof req !== "object" ||
    req === null ||
    typeof req.method !== "string" ||
    typeof req.headers !== "object"
  ) {
    throw new TypeError("Model tester routes require a Node HTTP request");
  }
}

function assertHttpServerResponse(
  res: RouteResponse,
): asserts res is NodeRouteResponse {
  if (
    typeof res !== "object" ||
    res === null ||
    typeof res.end !== "function" ||
    typeof res.setHeader !== "function"
  ) {
    throw new TypeError("Model tester routes require a Node HTTP response");
  }
}

function toHttpIncomingMessage(req: RouteRequest): http.IncomingMessage {
  assertHttpIncomingMessage(req);
  return req;
}

function toHttpServerResponse(res: RouteResponse): http.ServerResponse {
  assertHttpServerResponse(res);
  return res;
}

const modelTesterRoutes: Route[] = [
  {
    type: "GET",
    path: "/model-tester",
    rawPath: true,
    handler: async (_req, res, runtime) => {
      await handleModelTesterRoute(
        toHttpIncomingMessage(_req),
        toHttpServerResponse(res),
        "/model-tester",
        "GET",
        runtime,
      );
    },
  },
  {
    type: "GET",
    path: "/api/model-tester/status",
    rawPath: true,
    handler: async (_req, res, runtime) => {
      await handleModelTesterRoute(
        toHttpIncomingMessage(_req),
        toHttpServerResponse(res),
        "/api/model-tester/status",
        "GET",
        runtime,
      );
    },
  },
  {
    type: "POST",
    path: "/api/model-tester/run",
    rawPath: true,
    handler: async (req, res, runtime) => {
      await handleModelTesterRoute(
        toHttpIncomingMessage(req),
        toHttpServerResponse(res),
        "/api/model-tester/run",
        "POST",
        runtime,
      );
    },
  },
];

export const modelTesterPlugin: Plugin = {
  name: "@elizaos/app-model-tester",
  description:
    "UI applet routes for end-to-end Eliza-1 text, embedding, speech, transcription, VAD, and vision probes.",
  routes: modelTesterRoutes,
  views: [
    // ONE declaration → GUI + XR + TUI, all drawn from the single
    // ModelTesterView spatial source. `modalities` is a plain literal here
    // (plugin.ts is not in the view bundle), so no brand-new `@elizaos/core`
    // runtime export reaches the bundle build.
    {
      id: "model-tester",
      label: "Model Tester",
      developerOnly: true,
      description:
        "End-to-end probes for Eliza-1 text, voice, audio, and vision models",
      icon: "TestTube2",
      path: "/model-tester",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      componentExport: "ModelTesterView",
      capabilities: [
        { id: "get-status", description: "Return model probe readiness" },
        { id: "run-text-small", description: "Run the TEXT_SMALL probe" },
        { id: "run-transcription", description: "Run the transcription probe" },
        { id: "run-vision", description: "Run the vision description probe" },
        { id: "run-vad", description: "Run the voice activity probe" },
      ],
      tags: ["developer", "models", "testing"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};
