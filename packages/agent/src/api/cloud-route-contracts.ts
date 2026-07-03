import type http from "node:http";
import type { RouteHelpers } from "@elizaos/core";
import type { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability.ts";
import type { ServerState } from "./server-types.ts";

export interface AgentCloudProxyRouteState {
  config: ServerState["config"];
  runtime: ServerState["runtime"];
}

export interface AgentCloudRouteState extends AgentCloudProxyRouteState {
  cloudManager: ServerState["cloudManager"];
  saveConfig: (config: ServerState["config"]) => void;
  createTelemetrySpan: typeof createIntegrationTelemetrySpan;
  restartRuntime: (reason: string) => Promise<boolean>;
}

export interface AgentCloudRelayRouteState {
  runtime?: {
    getService(type: string): unknown;
    getSetting?: (key: string) => string | number | boolean | null;
  };
}

export interface AgentCloudStatusRouteContext {
  res: http.ServerResponse;
  method: string;
  pathname: string;
  config: ServerState["config"];
  runtime: ServerState["runtime"];
  json: RouteHelpers["json"];
}

export type AgentCloudBillingRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: AgentCloudProxyRouteState,
) => Promise<boolean>;

export type AgentCloudCompatRouteHandler = AgentCloudBillingRouteHandler;

export type AgentCloudRelayRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: AgentCloudRelayRouteState,
  helpers: RouteHelpers,
) => Promise<boolean>;

export type AgentCloudRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: AgentCloudRouteState,
) => Promise<boolean>;

export type AgentCloudStatusRouteHandler = (
  ctx: AgentCloudStatusRouteContext,
) => Promise<boolean>;
