import type http from "node:http";
import type { Plugin, Route, RouteRequest, RouteResponse } from "@elizaos/core";
import { handleModelTesterRoute } from "./routes.js";

function toHttpIncomingMessage(req: RouteRequest): http.IncomingMessage {
  if (
    typeof req !== "object" ||
    req === null ||
    typeof req.method !== "string" ||
    typeof req.headers !== "object"
  ) {
    throw new TypeError("Model tester routes require a Node HTTP request");
  }
  return req as unknown as http.IncomingMessage;
}

function toHttpServerResponse(res: RouteResponse): http.ServerResponse {
  if (
    typeof res !== "object" ||
    res === null ||
    typeof res.end !== "function" ||
    typeof res.setHeader !== "function"
  ) {
    throw new TypeError("Model tester routes require a Node HTTP response");
  }
  return res as unknown as http.ServerResponse;
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
    {
      id: "model-tester",
      label: "Model Tester",
      description:
        "End-to-end probes for Eliza-1 text, voice, audio, and vision models",
      icon: "TestTube2",
      path: "/model-tester",
      bundlePath: "dist/views/bundle.js",
      componentExport: "ModelTesterAppView",
      tags: ["developer", "models", "testing"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
    {
      id: "model-tester",
      label: "Model Tester TUI",
      description:
        "Terminal probes for Eliza-1 text, voice, audio, and vision models",
      icon: "TestTube2",
      path: "/model-tester/tui",
      viewType: "tui",
      bundlePath: "dist/views/bundle.js",
      componentExport: "ModelTesterTuiView",
      capabilities: [
        { id: "get-status", description: "Return model probe readiness" },
        { id: "run-text-small", description: "Run the TEXT_SMALL probe" },
        { id: "run-transcription", description: "Run the transcription probe" },
        { id: "run-vision", description: "Run the vision description probe" },
        { id: "run-vad", description: "Run the voice activity probe" },
      ],
      tags: ["developer", "models", "testing", "terminal"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};
