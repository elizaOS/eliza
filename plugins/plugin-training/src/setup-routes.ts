/**
 * `trainingPlugin` definition — registers the training and trajectory HTTP
 * routes (with `rawPath: true`) and the fine-tuning views through the plugin
 * route registry.
 *
 * The handlers read the live TrainingService from the in-process registry
 * (`getActiveTrainingService`), which server.ts startup populates after it
 * builds the service instance with `getConfig` / `setConfig` callbacks.
 * Trajectory routes do not require the TrainingService — they work directly
 * against the AgentRuntime.
 */

import type http from "node:http";
import { TLSSocket } from "node:tls";
import type {
  AgentRuntime,
  LegacyRouteHandler,
  Plugin,
  Route,
} from "@elizaos/core";
import {
  sendJson as httpSendJson,
  sendJsonError as httpSendJsonError,
} from "@elizaos/core";
import { readJsonBody as httpReadJsonBody } from "@elizaos/shared";
import { loadTrainingConfig } from "./core/training-config.js";
import {
  EXPERIENCE_ROUTE_PATHS,
  handleExperienceRoutes,
} from "./routes/experience-routes.js";
import { handleTrainingRoutes } from "./routes/training-routes.js";
import { handleVastTrainingRoutes } from "./routes/training-vast-routes.js";
import { handleTrajectoryRoute } from "./routes/trajectory-routes.js";
import { getActiveTrainingService } from "./services/training-service-registry.js";
import { VastTrainingService } from "./services/training-vast-service.js";

// In a terminal host (the Node agent, no DOM), register the training view so it
// renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
// stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view.js")
    .then((m) => m.registerFineTuningTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
  "0.0.0.0",
]);

function emptyTrainingTaskCounters(): Record<string, number> {
  return {
    should_respond: 0,
    context_routing: 0,
    action_planner: 0,
    response: 0,
    media_description: 0,
  };
}

function isLoopbackHost(host: string): boolean {
  if (!host) return false;
  const trimmed = host.trim();
  if (LOOPBACK_HOSTS.has(trimmed)) return true;
  const noPort = trimmed.replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(noPort);
}

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
  const headers = req.headers;
  const protocol =
    firstHeaderValue(headers["x-forwarded-proto"]) ??
    (req.socket instanceof TLSSocket && req.socket.encrypted
      ? "https"
      : "http");
  const host =
    firstHeaderValue(headers["x-forwarded-host"]) ??
    firstHeaderValue(headers.host) ??
    "localhost";
  return `${protocol}://${host}`;
}

function trainingRouteHandler(): LegacyRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const agentRuntime = (runtime as AgentRuntime) ?? null;
    const trainingService = getActiveTrainingService();
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = new URL(httpReq.url ?? "/", requestBaseUrl(httpReq));
    if (!trainingService) {
      if (method === "GET" && url.pathname === "/api/training/auto/config") {
        json(httpRes, { config: loadTrainingConfig() });
        return;
      }
      if (method === "GET" && url.pathname === "/api/training/auto/status") {
        const config = loadTrainingConfig();
        json(httpRes, {
          autoTrainEnabled: config.autoTrain,
          triggerThreshold: config.triggerThreshold,
          cooldownHours: config.triggerCooldownHours,
          counters: emptyTrainingTaskCounters(),
          lastTrain: {},
          perTaskThresholds: emptyTrainingTaskCounters(),
          perTaskCooldownMs: emptyTrainingTaskCounters(),
          serviceRegistered: false,
        });
        return;
      }
      error(httpRes, "Training service is not available", 503);
      return;
    }
    await handleTrainingRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
      runtime: agentRuntime,
      trainingService,
      readJsonBody: httpReadJsonBody,
      json,
      error,
      isLoopbackHost,
    });
  };
}

let cachedVastService: VastTrainingService | null = null;
function getVastService(): VastTrainingService {
  if (!cachedVastService) cachedVastService = new VastTrainingService();
  return cachedVastService;
}

function vastTrainingRouteHandler(): LegacyRouteHandler {
  return async (req: unknown, res: unknown): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = new URL(httpReq.url ?? "/", requestBaseUrl(httpReq));
    await handleVastTrainingRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
      service: getVastService(),
      readJsonBody: httpReadJsonBody,
      json,
      error,
    });
  };
}

function trajectoryRouteHandler(): LegacyRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const agentRuntime = (runtime as AgentRuntime) ?? null;
    if (!agentRuntime) {
      error(httpRes, "Agent runtime not started yet", 503);
      return;
    }
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = new URL(httpReq.url ?? "/", requestBaseUrl(httpReq));
    await handleTrajectoryRoute(
      httpReq,
      httpRes,
      agentRuntime,
      url.pathname,
      method,
    );
  };
}

function experienceRouteHandler(): LegacyRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const agentRuntime = (runtime as AgentRuntime) ?? null;
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = new URL(httpReq.url ?? "/", requestBaseUrl(httpReq));
    await handleExperienceRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
      runtime: agentRuntime,
      url,
      readJsonBody: httpReadJsonBody,
      json,
      error,
    });
  };
}

const TRAINING_ROUTES: Array<{ type: string; path: string }> = [
  // Static training endpoints
  { type: "GET", path: "/api/training/status" },
  { type: "GET", path: "/api/training/auto/status" },
  { type: "POST", path: "/api/training/auto/trigger" },
  { type: "GET", path: "/api/training/auto/runs" },
  { type: "GET", path: "/api/training/auto/runs/:runId" },
  { type: "GET", path: "/api/training/auto/config" },
  { type: "POST", path: "/api/training/auto/config" },
  // Analysis + readiness
  { type: "POST", path: "/api/training/analysis/index" },
  { type: "POST", path: "/api/training/analysis/readiness" },
  // Data collection pipeline
  { type: "GET", path: "/api/training/collections" },
  { type: "POST", path: "/api/training/collect" },
  { type: "POST", path: "/api/training/feed/generate" },
  { type: "POST", path: "/api/training/scenarios/run" },
  { type: "POST", path: "/api/training/datasets/ingest-hf" },
  // Evals + benchmarks
  { type: "POST", path: "/api/training/evals/record-comparison" },
  { type: "POST", path: "/api/training/evals/run-local-comparison" },
  { type: "POST", path: "/api/training/benchmarks/action-selection/run" },
  { type: "POST", path: "/api/training/benchmarks/matrix" },
  { type: "POST", path: "/api/training/benchmarks/matrix/from-artifacts" },
  { type: "POST", path: "/api/training/benchmarks/run-vs-cerebras" },
  { type: "POST", path: "/api/training/models/stage-eliza1-bundle" },
  { type: "GET", path: "/api/training/trajectories" },
  { type: "GET", path: "/api/training/trajectories/:trajectoryId" },
  { type: "POST", path: "/api/training/trajectories/export" },
  { type: "POST", path: "/api/training/trajectories/publish" },
  { type: "GET", path: "/api/training/datasets" },
  { type: "POST", path: "/api/training/datasets/build" },
  { type: "GET", path: "/api/training/backends" },
  { type: "GET", path: "/api/training/jobs" },
  { type: "POST", path: "/api/training/jobs" },
  { type: "GET", path: "/api/training/jobs/:jobId" },
  { type: "POST", path: "/api/training/jobs/:jobId/cancel" },
  { type: "GET", path: "/api/training/models" },
  { type: "POST", path: "/api/training/models/:modelId/import-ollama" },
  { type: "POST", path: "/api/training/models/:modelId/activate" },
  { type: "POST", path: "/api/training/models/:modelId/benchmark" },
  { type: "GET", path: "/api/training/blueprints" },
  { type: "GET", path: "/api/training/context-catalog" },
  { type: "GET", path: "/api/training/context-audit" },
  { type: "POST", path: "/api/training/generate-dataset" },
  { type: "POST", path: "/api/training/generate-roleplay" },
  { type: "POST", path: "/api/training/roleplay/execute" },
];

const VAST_ROUTES: Array<{ type: string; path: string }> = [
  { type: "POST", path: "/api/training/vast/jobs" },
  { type: "GET", path: "/api/training/vast/jobs" },
  { type: "GET", path: "/api/training/vast/jobs/:id" },
  { type: "POST", path: "/api/training/vast/jobs/:id/cancel" },
  { type: "POST", path: "/api/training/vast/jobs/:id/eval" },
  { type: "GET", path: "/api/training/vast/jobs/:id/logs" },
  { type: "GET", path: "/api/training/vast/jobs/:id/budget" },
  { type: "GET", path: "/api/training/vast/models" },
  { type: "GET", path: "/api/training/vast/models/:short_name/checkpoints" },
  { type: "GET", path: "/api/training/vast/inference/endpoints" },
  { type: "POST", path: "/api/training/vast/inference/endpoints" },
  { type: "DELETE", path: "/api/training/vast/inference/endpoints/:id" },
  { type: "GET", path: "/api/training/vast/inference/stats" },
];

const TRAJECTORY_ROUTES: Array<{ type: string; path: string }> = [
  { type: "GET", path: "/api/trajectories" },
  { type: "DELETE", path: "/api/trajectories" },
  { type: "GET", path: "/api/trajectories/config" },
  { type: "PUT", path: "/api/trajectories/config" },
  { type: "POST", path: "/api/trajectories/export" },
  { type: "GET", path: "/api/trajectories/stats" },
  { type: "GET", path: "/api/trajectories/:id" },
];

export const trainingRoutes: Route[] = [
  ...TRAINING_ROUTES.map(
    (r) =>
      ({
        type: r.type as Route["type"],
        path: r.path,
        rawPath: true as const,
        handler: trainingRouteHandler(),
      }) as Route,
  ),
  ...VAST_ROUTES.map(
    (r) =>
      ({
        type: r.type as Route["type"],
        path: r.path,
        rawPath: true as const,
        handler: vastTrainingRouteHandler(),
      }) as Route,
  ),
  ...TRAJECTORY_ROUTES.map(
    (r) =>
      ({
        type: r.type as Route["type"],
        path: r.path,
        rawPath: true as const,
        handler: trajectoryRouteHandler(),
      }) as Route,
  ),
  ...EXPERIENCE_ROUTE_PATHS.map(
    (r) =>
      ({
        type: r.type as Route["type"],
        path: r.path,
        rawPath: true as const,
        handler: experienceRouteHandler(),
      }) as Route,
  ),
];

export const trainingPlugin: Plugin = {
  name: "@elizaos/plugin-training-routes",
  description:
    "Training jobs, datasets, models, blueprints, and trajectory routes",
  routes: trainingRoutes,
  views: [
    // ONE declaration → GUI + XR + TUI, ONE componentExport. `FineTuningView`
    // is an adaptive wrapper: GUI/XR render the rich `FineTuningDashboard`
    // through the spatial `Escape` hatch, TUI falls back to the presentational
    // `FineTuningSpatialView` — the same source the agent terminal renders
    // directly via the spatial terminal registry (see register-terminal-view.tsx).
    // `modalities` is a plain literal here, so no brand-new `@elizaos/core`
    // runtime export reaches the bundle build.
    {
      id: "training",
      label: "Training",
      description:
        "Fine-tuning jobs, data collection, analysis, evals, benchmarks, trained models, and trajectory management",
      icon: "BrainCircuit",
      path: "/apps/fine-tuning",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      componentExport: "FineTuningView",
      relatedActions: ["RUNTIME"],
      tags: [
        "training",
        "fine-tuning",
        "models",
        "trajectories",
        "datasets",
        "evals",
        "benchmarks",
        "analysis",
        "data-collection",
      ],
      developerOnly: true,
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};
