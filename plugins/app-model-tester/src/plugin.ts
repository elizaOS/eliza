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
};
