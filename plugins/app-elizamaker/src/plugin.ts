import type http from "node:http";
import {
  readJsonBody as httpReadJsonBody,
  sendJson as httpSendJson,
  sendJsonError as httpSendJsonError,
} from "@elizaos/core";
import { getWalletAddresses, } from "@elizaos/agent";
import type { AgentRuntime, Plugin, Route } from "@elizaos/core";
import { handleDropRoutes } from "./drop-routes.js";
import { getElizaMakerDropService } from "./drop-service-registry.js";
import { initializeRegistryAndDropServices } from "./init-registry-services.js";
import { readOGCode } from "./og-tracker.js";

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  httpSendJson(res, data, status);
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  httpSendJsonError(res, message, status);
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return firstHeaderValue(value[0]);
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.split(",")[0]?.trim();
  return normalized ? normalized : null;
}

function requestBaseUrl(req: http.IncomingMessage): string {
  const protocol = firstHeaderValue(req.headers["x-forwarded-proto"]) ?? "http";
  const host =
    firstHeaderValue(req.headers["x-forwarded-host"]) ??
    firstHeaderValue(req.headers.host) ??
    "localhost";
  return `${protocol}://${host}`;
}

function agentNameFromRuntime(runtime: AgentRuntime | null): string {
  return runtime?.character?.name ?? "Eliza";
}

function getOptionalWalletAddresses(): {
  evmAddress?: string;
  solanaAddress?: string;
} {
  const addresses = getWalletAddresses();
  return {
    evmAddress: addresses.evmAddress ?? undefined,
    solanaAddress: addresses.solanaAddress ?? undefined,
  };
}

function elizaMakerRouteHandler(): NonNullable<Route["handler"]> {
  return async (req, res, runtime) => {
    const httpReq = req as unknown as http.IncomingMessage;
    const httpRes = res as unknown as http.ServerResponse;
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = new URL(httpReq.url ?? "/", requestBaseUrl(httpReq));

    await handleDropRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
      url,
      json,
      error,
      readJsonBody: httpReadJsonBody,
      dropService: getElizaMakerDropService(),
      agentName: agentNameFromRuntime(runtime as AgentRuntime | null),
      getWalletAddresses: getOptionalWalletAddresses,
      readOGCodeFromState: readOGCode,
    });
  };
}

const elizaMakerRoute = elizaMakerRouteHandler();

const elizaMakerRouteSpecs: Array<Pick<Route, "type" | "path" | "rawPath">> = [
  { type: "GET", path: "/api/drop/status", rawPath: true },
  { type: "POST", path: "/api/drop/mint", rawPath: true },
  { type: "POST", path: "/api/drop/mint-whitelist", rawPath: true },
  { type: "GET", path: "/api/whitelist/status", rawPath: true },
  { type: "POST", path: "/api/whitelist/twitter/message", rawPath: true },
  { type: "POST", path: "/api/whitelist/twitter/verify", rawPath: true },
  { type: "GET", path: "/api/whitelist/merkle/root", rawPath: true },
  { type: "GET", path: "/api/whitelist/merkle/proof", rawPath: true },
];

const elizaMakerRoutes: Route[] = elizaMakerRouteSpecs.map((route) => ({
  ...route,
  handler: elizaMakerRoute,
}));

export const elizaMakerPlugin: Plugin = {
  name: "@elizaos/app-elizamaker",
  description:
    "ElizaMaker ERC-8041 drop, mint, whitelist, and Merkle proof routes.",
  routes: elizaMakerRoutes,
  init: async (_config, runtime) => {
    // Bootstrap RegistryService + DropService asynchronously so that plugin
    // registration does not block on outbound RPC probes. Mirrors the
    // pre-extraction startDeferredStartupWork timing in server.ts.
    void initializeRegistryAndDropServices(runtime);
  },
};

export default elizaMakerPlugin;
