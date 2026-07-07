/**
 * Executes one scenario end-to-end against a live runtime:
 *   1. Check `requires` gates — skip with reason if a required plugin/credential
 *      isn't available.
 *   2. Run seed steps, including logical-clock steps like `advanceClock`.
 *   3. For each turn: execute `message`, `action`, `api`, or `tick`, capture
 *      response text/body/actions, and run per-turn assertions/judges.
 *   4. Run `finalChecks` via the handler registry.
 *   5. Aggregate + return a ScenarioReport.
 */

import * as crypto from "node:crypto";
import * as http from "node:http";
import type {
  Action,
  ActionResult,
  AgentRuntime,
  Memory,
  Plugin,
  RouteBodyValue,
  RouteRequest,
  RouteResponse,
  UUID,
} from "@elizaos/core";
import {
  ChannelType,
  createMessageMemory,
  logger,
  stringToUuid,
} from "@elizaos/core";
import type { VoiceWorkbenchScenarioRun } from "@elizaos/plugin-local-inference/voice-workbench";
import {
  type CapturedAction,
  type ScenarioContext,
  type ScenarioDefinition,
  type ScenarioFinalCheck,
  type ScenarioJudgeRubric,
  type ScenarioLane,
  type ScenarioTurn,
  type ScenarioTurnExecution,
  scenarioLane,
} from "@elizaos/scenario-runner/schema";
import { actionMatchesScenarioExpectation } from "./action-families.ts";
import { runFinalCheck } from "./final-checks/index.ts";
import { attachInterceptor } from "./interceptor.ts";
import { judgeTextWithLlm } from "./judge.ts";
import {
  deterministicJudgeFixturesActive,
  isJudgeIndependent,
  judgeIndependenceRequired,
} from "./judge-independence.ts";
import { redactForScenarioReport } from "./redaction.ts";
import { applyScenarioSeedStep } from "./seeds.ts";
import type {
  FinalCheckReport,
  RunnerContext,
  ScenarioReport,
} from "./types.ts";
import { isLoopbackUrl, toRecord } from "./utils.js";
import { executeVoiceTurn, voiceTurnAssertionFailures } from "./voice-turn.ts";

export interface ExecutorOptions {
  providerName: string;
  minJudgeScore: number;
  turnTimeoutMs: number;
}

/**
 * A finalCheck whose runtime dependency was missing (status `skipped`) must
 * never silently pass. In the pr-deterministic lane it fails the scenario —
 * that lane is the merge-blocking PR gate and a skipped check there is lost
 * coverage on every PR. Live lanes keep the scenario green but the skip is
 * loudly logged and counted in report totals (`finalChecksSkipped`).
 */
export function skippedFinalCheckFailure(
  lane: ScenarioLane,
  result: Pick<FinalCheckReport, "status" | "label" | "detail">,
): string | null {
  if (result.status !== "skipped" || lane !== "pr-deterministic") {
    return null;
  }
  return `finalCheck "${result.label}" skipped (${result.detail}) — a missing dependency is a failure in the pr-deterministic lane`;
}

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

type TurnMatcher = string | RegExp;

function responsePatternMatches(
  pattern: unknown,
  responseText: string,
): boolean {
  if (typeof pattern === "string") {
    return responseText.toLowerCase().includes(pattern.toLowerCase());
  }
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0;
    return pattern.test(responseText);
  }
  return false;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function isSynthesizedReplyAction(
  action: ScenarioTurnExecution["actionsCalled"][number],
): boolean {
  const data = toRecord(action.result?.data);
  return action.actionName === "REPLY" && data?.source === "synthesized-reply";
}

// The runtime message callback receives full `Content`; the executor only
// needs the reply text plus the structural failure marker set by
// `buildStructuredFailureReply` (packages/core/src/services/message.ts).
type SyntheticFailureAwareContent = {
  text?: string;
  elizaSyntheticFailure?: boolean;
};

function stringifyForAssertion(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isTurnMatcher(value: unknown): value is TurnMatcher {
  return typeof value === "string" || value instanceof RegExp;
}

function toTurnMatcherArray(value: unknown): TurnMatcher[] {
  if (isTurnMatcher(value)) {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isTurnMatcher);
}

function formatTurnMatcher(pattern: TurnMatcher): string {
  return pattern instanceof RegExp ? pattern.toString() : pattern;
}

function formatTurnMatchers(patterns: readonly TurnMatcher[]): string {
  return patterns.map(formatTurnMatcher).join(",");
}

function matchesTurnMatcher(value: string, pattern: TurnMatcher): boolean {
  if (typeof pattern === "string") {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
  pattern.lastIndex = 0;
  return pattern.test(value);
}

/**
 * The "planner trace" that `plannerIncludesAll`/`plannerIncludesAny`/
 * `plannerExcludes` match against: the executed action names plus their
 * parameters. There is no separate planner-text channel — the action trace IS
 * the observable plan.
 */
function buildPlannerAssertionBlob(execution: ScenarioTurnExecution): string {
  const parts: string[] = [];
  for (const action of execution.actionsCalled) {
    if (isSynthesizedReplyAction(action)) {
      continue;
    }
    parts.push(action.actionName);
    if (action.parameters !== undefined) {
      parts.push(stringifyForAssertion(action.parameters));
    }
  }
  return parts.join(" ");
}

type ScenarioRoomDefinition = {
  id: string;
  roomId: UUID;
  userId: UUID;
  worldId: UUID;
  source: string;
  channelType: ChannelType;
  userName: string;
};

// Mirrors the subset of the real (display-dependent) ComputerUseService that
// scenario providers/actions read through `getService("computeruse")`: the
// computer-state and scene providers and the COMPUTER_USE progress/CLIPBOARD
// paths call these at compose/run time, so a stub missing any of them throws
// mid-turn (e.g. `getApprovalSnapshot is not a function`).
type ScenarioComputerUseService = {
  getCapabilities: () => Record<string, { available: boolean; tool: string }>;
  getScreenDimensions: () => { width: number; height: number };
  getDisplays: () => Array<{
    id: number;
    name: string;
    bounds?: unknown;
    scaleFactor?: number;
    primary?: boolean;
  }>;
  getApprovalSnapshot: () => {
    mode: string;
    pendingCount: number;
    pendingApprovals: Array<{ id: string; command?: string }>;
  };
  getRecentActions: () => Array<{ action: string; success: boolean }>;
  getCurrentScene: () => null;
  refreshScene: (reason: string) => Promise<null>;
  executeDesktopAction: (params: Record<string, unknown>) => Promise<unknown>;
  executeBrowserAction: (params: Record<string, unknown>) => Promise<unknown>;
  executeFileAction: (params: Record<string, unknown>) => Promise<unknown>;
  executeWindowAction: (params: Record<string, unknown>) => Promise<unknown>;
  executeTerminalAction: (params: Record<string, unknown>) => Promise<unknown>;
};

type ExecutedTurn = ScenarioTurnExecution & {
  apiStatus?: number;
  apiBody?: unknown;
  durationMs?: number;
  reportResponseText?: string;
  syntheticFailure?: boolean;
};

type ScenarioVariableState = {
  baseNow: Date;
  capturesByName: Map<string, unknown>;
  definitionIdsByTitle: Map<string, string>;
  occurrenceIdsByTitle: Map<string, string>;
};

type ScenarioApiServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

type ScenarioRouteRequest = http.IncomingMessage &
  RouteRequest & {
    get?: (name: string) => string | undefined;
    protocol?: string;
  };

type ScenarioRouteResponse = http.ServerResponse & RouteResponse;

type RuntimeWithScenarioLlmFixtures = AgentRuntime & {
  scenarioLlmFixtures?: {
    clear?: () => void;
    resetConsumption?: () => void;
  };
  assertScenarioLlmFixturesConsumed?: () => void;
};

type SeedRunResult = {
  now: Date;
  error?: string;
};

function stringifyForJudge(value: unknown, maxLength = 1_200): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxLength) {
      return serialized;
    }
    return `${serialized.slice(0, maxLength - 3)}...`;
  } catch {
    return String(value);
  }
}

function resetScenarioLlmFixtures(runtime: AgentRuntime): void {
  const registry = (runtime as RuntimeWithScenarioLlmFixtures)
    .scenarioLlmFixtures;
  if (typeof registry?.clear === "function") {
    registry.clear();
    return;
  }
  registry?.resetConsumption?.();
}

function assertScenarioLlmFixturesConsumed(
  runtime: AgentRuntime,
): string | undefined {
  const assertConsumed = (runtime as RuntimeWithScenarioLlmFixtures)
    .assertScenarioLlmFixturesConsumed;
  if (typeof assertConsumed !== "function") {
    return undefined;
  }
  try {
    assertConsumed();
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function summarizeArtifactsForJudge(value: unknown): string | null {
  const artifacts = Array.isArray(value) ? value : null;
  if (!artifacts || artifacts.length === 0) {
    return null;
  }
  const labels = artifacts
    .map((artifact) => {
      const record = toRecord(artifact);
      if (!record) {
        return null;
      }
      const kind = typeof record.kind === "string" ? record.kind : "artifact";
      const label =
        typeof record.label === "string" && record.label.length > 0
          ? `:${record.label}`
          : "";
      return `${kind}${label}`;
    })
    .filter((entry): entry is string => entry !== null);
  if (labels.length === 0) {
    return null;
  }
  return labels.join(", ");
}

function summarizeActionForJudge(
  action: ScenarioTurnExecution["actionsCalled"][number],
): string {
  const lines = [`Action: ${action.actionName}`];
  if (action.parameters !== undefined) {
    lines.push(`Parameters: ${stringifyForJudge(action.parameters, 800)}`);
  }
  if (action.error?.message) {
    lines.push(`Error: ${action.error.message}`);
  }
  if (action.result) {
    if (typeof action.result.success === "boolean") {
      lines.push(`Success: ${action.result.success}`);
    }
    if (action.result.text) {
      lines.push(`Result text: ${action.result.text}`);
    }
    if (action.result.message) {
      lines.push(`Result message: ${action.result.message}`);
    }
    const data = toRecord(action.result.data);
    const browserTask = toRecord(data?.browserTask);
    if (browserTask) {
      lines.push(
        `Browser task: completed=${browserTask.completed === true}, needsHuman=${browserTask.needsHuman === true}`,
      );
      const browserArtifacts = summarizeArtifactsForJudge(
        browserTask.artifacts,
      );
      if (browserArtifacts) {
        lines.push(`Browser artifacts: ${browserArtifacts}`);
      }
    }
    const intervention = toRecord(data?.interventionRequest);
    if (intervention) {
      lines.push(
        `Intervention: status=${typeof intervention.status === "string" ? intervention.status : "unknown"}`,
      );
    }
    const artifacts = summarizeArtifactsForJudge(data?.artifacts);
    if (artifacts) {
      lines.push(`Artifacts: ${artifacts}`);
    }
    if (action.result.values !== undefined) {
      lines.push(`Values: ${stringifyForJudge(action.result.values, 500)}`);
    }
    if (data) {
      lines.push(`Data: ${stringifyForJudge(data, 900)}`);
    }
  }
  return lines.join("\n");
}

function buildExecutionJudgeCandidate(
  turn: ScenarioTurn,
  execution: ScenarioTurnExecution,
): string {
  const sections: string[] = [];
  if (typeof turn.text === "string" && turn.text.trim().length > 0) {
    sections.push(`User request:\n${turn.text}`);
  }
  if (execution.responseText?.trim()) {
    sections.push(`Assistant response:\n${execution.responseText}`);
  }
  if (execution.actionsCalled.length > 0) {
    sections.push(
      `Observed action trace:\n${execution.actionsCalled
        .map((action) => summarizeActionForJudge(action))
        .join("\n\n")}`,
    );
  }
  return sections.join("\n\n");
}

function buildScenarioJudgeCandidate(
  scenario: ScenarioDefinition,
  ctx: RunnerContext,
): string {
  const sections: string[] = [];
  if (typeof scenario.description === "string" && scenario.description.trim()) {
    sections.push(`Scenario description:\n${scenario.description}`);
  }
  const turnTrace = scenario.turns
    .map((turn, index) => {
      const execution = ctx.turns[index];
      const parts: string[] = [`Turn ${index + 1}: ${turn.name}`];
      if (typeof turn.text === "string" && turn.text.trim().length > 0) {
        parts.push(`User request: ${turn.text}`);
      }
      if (execution?.responseText?.trim()) {
        parts.push(`Assistant response: ${execution.responseText}`);
      }
      if (execution?.actionsCalled.length) {
        parts.push(
          `Actions:\n${execution.actionsCalled
            .map((action) => summarizeActionForJudge(action))
            .join("\n\n")}`,
        );
      }
      return parts.join("\n");
    })
    .filter((entry) => entry.trim().length > 0);
  if (turnTrace.length > 0) {
    sections.push(`Turn trace:\n${turnTrace.join("\n\n")}`);
  }
  if (ctx.connectorDispatches.length > 0) {
    sections.push(
      `Connector dispatches:\n${ctx.connectorDispatches
        .map((dispatch) => stringifyForJudge(dispatch, 500))
        .join("\n")}`,
    );
  }
  if (ctx.stateTransitions.length > 0) {
    sections.push(
      `State transitions:\n${ctx.stateTransitions
        .map((transition) => stringifyForJudge(transition, 400))
        .join("\n")}`,
    );
  }
  if (ctx.artifacts.length > 0) {
    sections.push(
      `Artifacts:\n${ctx.artifacts
        .map((artifact) => stringifyForJudge(artifact, 400))
        .join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function resolveRequiredPlugins(scenario: ScenarioDefinition): string[] {
  const requires = (scenario as { requires?: { plugins?: unknown } }).requires;
  const plugins = requires?.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.filter((p): p is string => typeof p === "string");
}

function pluginIsRegistered(runtime: AgentRuntime, name: string): boolean {
  const plugins =
    (runtime as { plugins?: Array<{ name?: unknown }> }).plugins ?? [];
  const normalized = name.replace(/^@elizaos\/plugin-/, "");
  return plugins.some((p) => {
    const pn = typeof p.name === "string" ? p.name : "";
    return pn === name || pn === normalized;
  });
}

async function loadRequiredPlugin(pkg: string): Promise<Plugin | null> {
  if (pkg === "@elizaos/plugin-app-control") {
    const mod = (await import(
      "../../../plugins/plugin-app-control/src/index.ts"
    )) as {
      appAction?: Action;
      appControlPlugin?: Plugin;
      backgroundAction?: Action;
      viewsAction?: Action;
      settingsAction?: Action;
    };
    // settingsAction is load-bearing for the app-permissions / semantic-SETTINGS
    // scenarios (#14622): without it the polymorphic SETTINGS action is never
    // registered here, so chat can never route a permission grant/revoke to it —
    // required, not optional, for the same reason app/background/views are.
    if (
      !mod.appAction ||
      !mod.backgroundAction ||
      !mod.viewsAction ||
      !mod.settingsAction
    )
      return null;
    return {
      name: "app-control",
      description: "App control deterministic scenario actions",
      actions: [
        mod.appAction,
        mod.backgroundAction,
        mod.viewsAction,
        mod.settingsAction,
      ],
      responseHandlerEvaluators:
        mod.appControlPlugin?.responseHandlerEvaluators,
    };
  }
  if (pkg === "@elizaos/plugin-hyperliquid") {
    const mod = (await import(
      "../../../plugins/plugin-hyperliquid/src/plugin.ts"
    )) as {
      hyperliquidPlugin?: Plugin;
    };
    return mod.hyperliquidPlugin ?? null;
  }
  if (pkg === "@elizaos/plugin-anthropic-proxy") {
    const mod = (await import(
      "../../../plugins/plugin-anthropic-proxy/index.ts"
    )) as {
      default?: Plugin;
      anthropicProxyPlugin?: Plugin;
    };
    return mod.default ?? mod.anthropicProxyPlugin ?? null;
  }

  const mod = (await import(pkg)) as Record<string, unknown>;
  const isPlugin = (value: unknown): value is Plugin => {
    if (value === null || typeof value !== "object") return false;
    const obj = value as Record<string, unknown>;
    if (typeof obj.name !== "string") return false;
    // A Plugin carries at least one registrable surface; this distinguishes it
    // from unrelated named exports that merely happen to have a `name` field.
    return (
      Array.isArray(obj.actions) ||
      Array.isArray(obj.providers) ||
      Array.isArray(obj.services) ||
      Array.isArray(obj.evaluators) ||
      Array.isArray(obj.routes) ||
      typeof obj.init === "function" ||
      typeof obj.models === "object"
    );
  };
  // Known export names first, then any Plugin-shaped named export: roughly half
  // of first-party plugins export only `const <name>Plugin` with no default,
  // which the fixed-name lookup alone would fail to resolve.
  const candidate =
    [mod.default, mod.elizaPlugin, mod.plugin, mod.schedulingPlugin].find(
      isPlugin,
    ) ?? Object.values(mod).find(isPlugin);
  return candidate ? (candidate as Plugin) : null;
}

function normalizeChannelType(value: unknown): ChannelType {
  if (typeof value !== "string") {
    return ChannelType.DM;
  }
  return Object.values(ChannelType).includes(value as ChannelType)
    ? (value as ChannelType)
    : ChannelType.DM;
}

function resolveScenarioRooms(
  scenario: ScenarioDefinition,
): ScenarioRoomDefinition[] {
  const worldId = stringToUuid(`scenario-runner-world:${scenario.id}`);
  const maybeRooms = (scenario as { rooms?: unknown }).rooms;
  const rooms = Array.isArray(maybeRooms) ? maybeRooms : [];
  const resolved = rooms
    .map((room, index) => {
      if (room === null || typeof room !== "object") {
        return null;
      }
      const raw = room as Record<string, unknown>;
      const id =
        typeof raw.id === "string" && raw.id.trim().length > 0
          ? raw.id.trim()
          : `room-${index + 1}`;
      const account =
        typeof raw.account === "string" && raw.account.trim().length > 0
          ? raw.account.trim()
          : `scenario-user:${scenario.id}:${id}`;
      const userName =
        typeof raw.title === "string" && raw.title.trim().length > 0
          ? raw.title.trim()
          : account;

      return {
        id,
        roomId: stringToUuid(`scenario-room:${scenario.id}:${id}`),
        userId: stringToUuid(`scenario-account:${account}`),
        worldId,
        source:
          typeof raw.source === "string" && raw.source.trim().length > 0
            ? raw.source.trim()
            : "scenario-runner",
        channelType: normalizeChannelType(raw.channelType),
        userName,
      } satisfies ScenarioRoomDefinition;
    })
    .filter((room): room is ScenarioRoomDefinition => room !== null);

  if (resolved.length > 0) {
    return resolved;
  }

  return [
    {
      id: "main",
      roomId: stringToUuid(`scenario-room:${scenario.id}:main`),
      userId: stringToUuid(`scenario-account:${scenario.id}:main`),
      worldId,
      source: "scenario-runner",
      channelType: ChannelType.DM,
      userName: "ScenarioUser",
    },
  ];
}

function resolveTurnRoom(
  turn: ScenarioTurn,
  rooms: readonly ScenarioRoomDefinition[],
): ScenarioRoomDefinition {
  const defaultRoom = getDefaultScenarioRoom(rooms);
  const requestedRoom =
    typeof turn.room === "string" && turn.room.trim().length > 0
      ? turn.room.trim()
      : null;
  if (!requestedRoom) {
    return defaultRoom;
  }
  return rooms.find((room) => room.id === requestedRoom) ?? defaultRoom;
}

function getDefaultScenarioRoom(
  rooms: readonly ScenarioRoomDefinition[],
): ScenarioRoomDefinition {
  const firstRoom = rooms[0];
  if (!firstRoom) {
    throw new Error("Scenario must resolve at least one room");
  }
  return firstRoom;
}

function matchRoutePath(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const normalize = (value: string) => value.split("/").filter(Boolean);
  const patternSegments = normalize(pattern);
  const pathSegments = normalize(pathname);
  if (patternSegments.length !== pathSegments.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i += 1) {
    const patternSegment = patternSegments[i];
    const pathSegment = pathSegments[i];
    if (!patternSegment || pathSegment === undefined) {
      return null;
    }
    if (patternSegment.startsWith(":")) {
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
      continue;
    }
    if (patternSegment !== pathSegment) {
      return null;
    }
  }
  return params;
}

function searchParamsToQuery(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of url.searchParams.keys()) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length <= 1 ? (values[0] ?? "") : values;
  }
  return query;
}

function attachResponseHelpers(
  res: http.ServerResponse,
): ScenarioRouteResponse {
  const response = res as ScenarioRouteResponse;
  if (typeof response.status === "function") {
    return response;
  }

  const sendPayload = (data: unknown) => {
    if (res.headersSent) {
      return response;
    }
    if (typeof data === "string" || Buffer.isBuffer(data)) {
      res.end(data);
      return response;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
    return response;
  };

  response.status = (code: number) => {
    res.statusCode = code;
    return response;
  };
  response.json = (data: unknown) => sendPayload(data);
  response.send = (data: unknown) => sendPayload(data);
  return response;
}

async function readRawRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toRouteBodyValue(value: unknown): RouteBodyValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toRouteBodyValue);
  }
  if (typeof value === "object") {
    const record: Record<string, RouteBodyValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      record[key] = toRouteBodyValue(entry);
    }
    return record;
  }
  return null;
}

function toRouteBody(value: unknown): Record<string, RouteBodyValue> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record: Record<string, RouteBodyValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      record[key] = toRouteBodyValue(entry);
    }
    return record;
  }
  return { value: toRouteBodyValue(value) };
}

async function augmentRequest(
  req: http.IncomingMessage,
  url: URL,
  params: Record<string, string>,
): Promise<ScenarioRouteRequest> {
  const protoHeader = req.headers["x-forwarded-proto"];
  const protocol =
    typeof protoHeader === "string"
      ? protoHeader.split(",")[0]?.trim() || "http"
      : "http";
  const request = req as ScenarioRouteRequest;
  request.query = searchParamsToQuery(url);
  request.params = params;
  request.protocol = protocol;
  request.path = url.pathname;
  request.method = req.method;
  request.url = req.url;
  request.get = (name: string) => {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  const rawBody = await readRawRequestBody(req);
  if (rawBody.length === 0) {
    return request;
  }
  request.rawBody = rawBody;
  // The stream is drained at this point. Route handlers that read the body
  // through @elizaos/core's `readJsonBody`/`readRequestBody` helpers attach
  // data/end listeners, which never fire on a consumed stream — the request
  // would hang until the turn timeout (#10757). Populate core's global-
  // registry body-cache symbol so those helpers resolve from cache instead
  // of re-reading the socket.
  (request as unknown as Record<symbol, Buffer>)[
    Symbol.for("eliza.http.cachedRequestBody")
  ] = Buffer.from(rawBody, "utf8");
  const contentType = request.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      request.body = toRouteBody(JSON.parse(rawBody));
    } catch {
      request.body = { value: rawBody };
    }
    return request;
  }
  request.body = { value: rawBody };
  return request;
}

async function startScenarioApiServer(
  runtime: AgentRuntime,
): Promise<ScenarioApiServer> {
  const server = http.createServer(async (req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    for (const route of runtime.routes ?? []) {
      if (route.type !== method || typeof route.handler !== "function") {
        continue;
      }
      const params =
        route.path === url.pathname
          ? {}
          : matchRoutePath(route.path, url.pathname);
      if (params === null) {
        continue;
      }
      const routeResponse = attachResponseHelpers(res);
      const routeRequest = await augmentRequest(req, url, params);
      try {
        await route.handler(routeRequest, routeResponse, runtime);
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "Internal Server Error" }));
        }
        // Log full error server-side for diagnostics; do not expose to client.
        logger.error(
          "[scenario-runner] route handler error",
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({ error: `No route matched ${method} ${url.pathname}` }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("[executor] failed to start scenario API server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function resolveNowToken(token: string, baseNow: Date): string | null {
  const match = token.match(/^now(?:([+-])(\d+)([mhdw]))?$/i);
  if (!match) {
    return null;
  }
  const [, sign, amountText, unit] = match;
  const resolved = new Date(baseNow.getTime());
  if (sign && amountText && unit) {
    const amount = Number.parseInt(amountText, 10);
    const multiplier =
      unit.toLowerCase() === "m"
        ? 60_000
        : unit.toLowerCase() === "h"
          ? 60 * 60_000
          : unit.toLowerCase() === "d"
            ? 24 * 60 * 60_000
            : 7 * 24 * 60 * 60_000;
    resolved.setTime(
      resolved.getTime() + (sign === "+" ? amount : -amount) * multiplier,
    );
  }
  return resolved.toISOString();
}

function addClockOffset(baseNow: Date, offset: string): Date {
  const normalizedOffset = /^[+-]/.test(offset) ? offset : `+${offset}`;
  const resolved = resolveNowToken(`now${normalizedOffset}`, baseNow);
  if (resolved === null) {
    throw new Error(`unsupported clock offset '${offset}'`);
  }
  return new Date(resolved);
}

function resolveScenarioTemplates(value: unknown, currentNow: Date): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{([^{}]{1,256})\}\}/g, (fullMatch, rawToken) => {
      const token = String(rawToken).trim();
      const resolved = resolveNowToken(token, currentNow);
      if (resolved === null) {
        throw new Error(
          `[executor] unsupported scenario template token ${fullMatch}`,
        );
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveScenarioTemplates(item, currentNow));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        resolveScenarioTemplates(item, currentNow),
      ]),
    );
  }
  return value;
}

function indexResponseIdentifiers(
  body: unknown,
  variables: ScenarioVariableState,
): void {
  const record = toRecord(body);
  const definition = toRecord(record?.definition);
  const definitionId =
    typeof definition?.id === "string" ? definition.id : undefined;
  const definitionTitle =
    typeof definition?.title === "string" ? definition.title : undefined;
  if (definitionId && definitionTitle) {
    variables.definitionIdsByTitle.set(definitionTitle, definitionId);
  }

  const occurrenceCollections = [
    record?.occurrences,
    toRecord(record?.owner)?.occurrences,
    toRecord(record?.agentOps)?.occurrences,
  ];
  for (const collection of occurrenceCollections) {
    if (!Array.isArray(collection)) {
      continue;
    }
    for (const item of collection) {
      const occurrence = toRecord(item);
      const occurrenceId =
        typeof occurrence?.id === "string" ? occurrence.id : undefined;
      const occurrenceTitle =
        typeof occurrence?.title === "string" ? occurrence.title : undefined;
      if (occurrenceId && occurrenceTitle) {
        variables.occurrenceIdsByTitle.set(occurrenceTitle, occurrenceId);
      }
    }
  }
}

function readCapturePath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    const record = toRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
}

function captureResponseFields(
  turn: ScenarioTurn,
  body: unknown,
  variables: ScenarioVariableState,
): void {
  const captures =
    turn.captures && typeof turn.captures === "object"
      ? turn.captures
      : undefined;
  if (!captures) return;

  for (const [name, path] of Object.entries(captures)) {
    const captureName = name.trim();
    if (!captureName) {
      throw new Error(
        `[executor] api turn '${turn.name}' has an empty capture name`,
      );
    }
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new Error(
        `[executor] api turn '${turn.name}' capture '${captureName}' is missing a response path`,
      );
    }
    const value = readCapturePath(body, path.trim());
    if (
      value === undefined ||
      (typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean")
    ) {
      throw new Error(
        `[executor] api turn '${turn.name}' could not capture '${captureName}' from response path '${path}'`,
      );
    }
    variables.capturesByName.set(captureName, value);
  }
}

async function lookupDefinitionIdByTitle(args: {
  apiServer: ScenarioApiServer;
  title: string;
  variables: ScenarioVariableState;
}): Promise<string> {
  const cached = args.variables.definitionIdsByTitle.get(args.title);
  if (cached) {
    return cached;
  }
  const response = await fetch(
    `${args.apiServer.baseUrl}/api/lifeops/definitions`,
  );
  const body = await response.json();
  const definitions = Array.isArray(toRecord(body)?.definitions)
    ? (toRecord(body)?.definitions as unknown[])
    : [];
  for (const entry of definitions) {
    const definition = toRecord(toRecord(entry)?.definition);
    const title =
      typeof definition?.title === "string" ? definition.title : undefined;
    const id = typeof definition?.id === "string" ? definition.id : undefined;
    if (title && id) {
      args.variables.definitionIdsByTitle.set(title, id);
      if (title === args.title) {
        return id;
      }
    }
  }
  throw new Error(
    `[executor] could not resolve definitionId for title "${args.title}"`,
  );
}

async function lookupOccurrenceIdByTitle(args: {
  apiServer: ScenarioApiServer;
  title: string;
  variables: ScenarioVariableState;
}): Promise<string> {
  const cached = args.variables.occurrenceIdsByTitle.get(args.title);
  if (cached) {
    return cached;
  }
  const response = await fetch(
    `${args.apiServer.baseUrl}/api/lifeops/overview`,
  );
  const body = await response.json();
  indexResponseIdentifiers(body, args.variables);
  const occurrenceId = args.variables.occurrenceIdsByTitle.get(args.title);
  if (occurrenceId) {
    return occurrenceId;
  }
  throw new Error(
    `[executor] could not resolve occurrenceId for title "${args.title}"`,
  );
}

async function resolveTemplateString(args: {
  value: string;
  apiServer: ScenarioApiServer;
  variables: ScenarioVariableState;
}): Promise<string> {
  const matches = Array.from(args.value.matchAll(/\{\{([^{}]{1,256})\}\}/g));
  if (matches.length === 0) {
    return args.value;
  }

  let resolved = args.value;
  for (const match of matches) {
    const token = match[1]?.trim() ?? "";
    const fullMatch = match[0];
    let replacement = resolveNowToken(token, args.variables.baseNow);
    if (replacement === null && token.startsWith("definitionId:")) {
      replacement = await lookupDefinitionIdByTitle({
        apiServer: args.apiServer,
        title: token.slice("definitionId:".length).trim(),
        variables: args.variables,
      });
    }
    if (replacement === null && token.startsWith("occurrenceId:")) {
      replacement = await lookupOccurrenceIdByTitle({
        apiServer: args.apiServer,
        title: token.slice("occurrenceId:".length).trim(),
        variables: args.variables,
      });
    }
    if (replacement === null && token.startsWith("capture:")) {
      const name = token.slice("capture:".length).trim();
      if (args.variables.capturesByName.has(name)) {
        replacement = String(args.variables.capturesByName.get(name));
      }
    }
    if (replacement === null) {
      throw new Error(
        `[executor] unsupported scenario template token ${fullMatch}`,
      );
    }
    const literalReplacement = replacement;
    // Replace via callback so `$` sequences in captured values (`$&`, `$$`,
    // `` $` ``) are inserted literally instead of being expanded as
    // replacement patterns.
    resolved = resolved.replace(fullMatch, () => literalReplacement);
  }
  return resolved;
}

async function resolveTemplateValue(args: {
  value: unknown;
  apiServer: ScenarioApiServer;
  variables: ScenarioVariableState;
}): Promise<unknown> {
  if (typeof args.value === "string") {
    return await resolveTemplateString({
      value: args.value,
      apiServer: args.apiServer,
      variables: args.variables,
    });
  }
  if (Array.isArray(args.value)) {
    return await Promise.all(
      args.value.map((item) =>
        resolveTemplateValue({
          value: item,
          apiServer: args.apiServer,
          variables: args.variables,
        }),
      ),
    );
  }
  if (args.value && typeof args.value === "object") {
    const entries = await Promise.all(
      Object.entries(args.value as Record<string, unknown>).map(
        async ([key, value]) => [
          key,
          await resolveTemplateValue({
            value,
            apiServer: args.apiServer,
            variables: args.variables,
          }),
        ],
      ),
    );
    return Object.fromEntries(entries);
  }
  return args.value;
}

function createScenarioComputerUseService(): ScenarioComputerUseService {
  const run = async (params: Record<string, unknown>) => {
    const blob = JSON.stringify(params).toLowerCase();
    const isDriveWorkflow = /drive|doc|sheet|provenance|auth/.test(blob);
    const isPortalWorkflow = /portal|upload|browser|resume|blocked|file/.test(
      blob,
    );
    const needsHuman =
      /help|blocked|resume|auth|login|sign in/.test(blob) || isPortalWorkflow;
    const label = isDriveWorkflow ? "drive-docs-upload" : "portal-upload";
    const message = isDriveWorkflow
      ? "Drive doc sheet upload completed with provenance and auth status review."
      : "Portal upload completed and human help was requested before resume.";
    const artifact = {
      kind: "uploaded_asset",
      label,
      detail: `scenario://${label}`,
    };

    return {
      success: true,
      message,
      text: message,
      data: {
        browserTask: {
          completed: true,
          needsHuman,
          artifacts: [artifact],
        },
        artifacts: [artifact],
        interventionRequest: needsHuman
          ? {
              id: `scenario-${label}`,
              status: "requested",
            }
          : undefined,
      },
      attachments: [
        {
          kind: "uploaded_asset",
          label,
          path: `/tmp/${label}.txt`,
        },
      ],
      path: `/tmp/${label}.txt`,
    };
  };

  return {
    getCapabilities() {
      return {
        screenshot: { available: true, tool: "scenario-screenshot" },
        computerUse: { available: true, tool: "scenario-desktop" },
        windowList: { available: true, tool: "scenario-window-list" },
        browser: { available: true, tool: "scenario-browser" },
        terminal: { available: true, tool: "scenario-terminal" },
        fileSystem: { available: true, tool: "scenario-file-system" },
        clipboard: { available: true, tool: "scenario-clipboard" },
      };
    },
    getScreenDimensions: () => ({ width: 2560, height: 1600 }),
    getDisplays: () => [],
    getApprovalSnapshot: () => ({
      mode: "full_control",
      pendingCount: 0,
      pendingApprovals: [],
    }),
    getRecentActions: () => [],
    getCurrentScene: () => null,
    refreshScene: async () => null,
    executeDesktopAction: run,
    executeBrowserAction: run,
    executeFileAction: run,
    executeWindowAction: run,
    executeTerminalAction: run,
  };
}

async function runCustomSeeds(
  scenario: ScenarioDefinition,
  runtime: AgentRuntime,
  ctx: RunnerContext,
  initialNow: Date,
): Promise<SeedRunResult> {
  const seeds = (scenario as { seed?: unknown }).seed;
  if (!Array.isArray(seeds)) {
    ctx.now = initialNow.toISOString();
    return { now: initialNow };
  }
  let currentNow = new Date(initialNow.getTime());
  for (const seed of seeds) {
    if (seed === null || typeof seed !== "object") continue;
    const resolvedSeed = resolveScenarioTemplates(
      seed,
      currentNow,
    ) as typeof seed;
    const { type, name, apply } = resolvedSeed as {
      type?: unknown;
      name?: unknown;
      apply?: unknown;
      by?: unknown;
    };
    if (type === "advanceClock") {
      if (typeof (resolvedSeed as { by?: unknown }).by !== "string") {
        return {
          now: currentNow,
          error: `seed ${name ?? "(unnamed)"} missing string 'by' offset`,
        };
      }
      try {
        currentNow = addClockOffset(
          currentNow,
          (resolvedSeed as { by: string }).by,
        );
        ctx.now = currentNow.toISOString();
      } catch (err) {
        return {
          now: currentNow,
          error: `seed ${name ?? "(unnamed)"} threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      continue;
    }
    const scenarioCtx: ScenarioContext = {
      ...ctx,
      runtime,
      now: currentNow.toISOString(),
    };
    if (type === "custom" && typeof apply === "function") {
      try {
        const result = await (apply as (c: ScenarioContext) => unknown)(
          scenarioCtx,
        );
        if (typeof result === "string" && result.length > 0) {
          return {
            now: currentNow,
            error: `seed ${name ?? "(unnamed)"}: ${result}`,
          };
        }
      } catch (err) {
        return {
          now: currentNow,
          error: `seed ${name ?? "(unnamed)"} threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      continue;
    }

    try {
      const result = await applyScenarioSeedStep(
        scenarioCtx,
        resolvedSeed as Exclude<ScenarioDefinition["seed"], undefined>[number],
      );
      if (typeof result === "string" && result.length > 0) {
        return {
          now: currentNow,
          error: `seed ${name ?? "(unnamed)"}: ${result}`,
        };
      }
    } catch (err) {
      return {
        now: currentNow,
        error: `seed ${name ?? "(unnamed)"} threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  ctx.now = currentNow.toISOString();
  return { now: currentNow };
}

async function deleteMockGmailDrafts(): Promise<string | undefined> {
  const baseUrl = process.env.ELIZA_MOCK_GOOGLE_BASE;
  if (!isLoopbackUrl(baseUrl)) {
    return "gmailDeleteDrafts cleanup requires ELIZA_MOCK_GOOGLE_BASE to point at the loopback Google mock";
  }
  const response = await fetch(`${baseUrl}/gmail/v1/users/me/drafts`);
  if (!response.ok) {
    return `gmailDeleteDrafts list failed with HTTP ${response.status}`;
  }
  const body = (await response.json()) as { drafts?: unknown };
  const drafts = Array.isArray(body.drafts) ? body.drafts : [];
  for (const draft of drafts) {
    if (!draft || typeof draft !== "object") {
      continue;
    }
    const id = (draft as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) {
      continue;
    }
    const deleteResponse = await fetch(
      `${baseUrl}/gmail/v1/users/me/drafts/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (!deleteResponse.ok) {
      return `gmailDeleteDrafts delete ${id} failed with HTTP ${deleteResponse.status}`;
    }
  }
  return undefined;
}

async function clearSelfControlBlocks(): Promise<string | undefined> {
  const { stopSelfControlBlock } = await import(
    "@elizaos/plugin-blocker/services/website-blocker/index"
  );
  const result = await stopSelfControlBlock();
  if (result.success) {
    return undefined;
  }
  return `selfControlClearBlocks failed: ${result.error}`;
}

async function runScenarioCleanups(
  scenario: ScenarioDefinition,
  runtime: AgentRuntime,
  ctx: RunnerContext,
): Promise<string[]> {
  const cleanups = (scenario as { cleanup?: unknown }).cleanup;
  if (!Array.isArray(cleanups)) {
    return [];
  }
  const failures: string[] = [];
  for (const cleanup of cleanups) {
    if (!cleanup || typeof cleanup !== "object") {
      continue;
    }
    const step = cleanup as {
      type?: unknown;
      name?: unknown;
      apply?: unknown;
    };
    let result: string | undefined;
    try {
      if (step.type === "gmailDeleteDrafts") {
        result = await deleteMockGmailDrafts();
      } else if (step.type === "selfControlClearBlocks") {
        result = await clearSelfControlBlocks();
      } else if (step.type === "custom" && typeof step.apply === "function") {
        const scenarioCtx: ScenarioContext = {
          ...ctx,
          runtime,
        };
        const customResult = await (
          step.apply as (c: ScenarioContext) => unknown
        )(scenarioCtx);
        result =
          typeof customResult === "string" && customResult.length > 0
            ? customResult
            : undefined;
      } else {
        continue;
      }
      if (result) {
        failures.push(`cleanup ${String(step.name ?? step.type)}: ${result}`);
      }
    } catch (err) {
      failures.push(
        `cleanup ${String(step.name ?? step.type)} threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return failures;
}

async function executeMessageTurn(
  runtime: AgentRuntime,
  turn: ScenarioTurn,
  room: ScenarioRoomDefinition,
  currentNow: Date,
  turnTimeoutMs: number,
  scenarioId: string,
  runId?: string,
): Promise<{
  responseText: string;
  durationMs: number;
  syntheticFailure: boolean;
}> {
  const text =
    typeof turn.text === "string"
      ? String(resolveScenarioTemplates(turn.text, currentNow))
      : "";
  if (text.length === 0) {
    throw new Error(`[executor] turn '${turn.name}' has no text to send`);
  }

  const turnContent =
    turn.content !== null && typeof turn.content === "object"
      ? (turn.content as Record<string, unknown>)
      : {};

  const message: Memory = createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: room.userId,
    roomId: room.roomId,
    content: {
      ...turnContent,
      text,
      source: room.source,
      channelType: room.channelType,
    },
  });
  message.metadata = {
    ...(message.metadata &&
    typeof message.metadata === "object" &&
    !Array.isArray(message.metadata)
      ? message.metadata
      : {}),
    scenarioId,
    ...(runId ? { batchId: runId } : {}),
  };

  const messageService = (
    runtime as {
      messageService?: {
        handleMessage: (
          rt: AgentRuntime,
          memory: Memory,
          cb: (content: SyntheticFailureAwareContent) => Promise<unknown>,
          options?: Record<string, unknown>,
        ) => Promise<{
          responseContent?: SyntheticFailureAwareContent;
          responseMessages?: Memory[];
        }>;
      };
    }
  ).messageService;
  if (!messageService) {
    throw new Error(
      "[executor] runtime.messageService is not initialized — cannot send messages",
    );
  }

  const startedAt = Date.now();
  let responseText = "";
  // The runtime synthesizes a failure reply (rate-limit / auth / credits /
  // generic apology) when a model call fails; it carries the structural
  // `elizaSyntheticFailure` flag the chat DTO and recent-messages filter
  // already key on. Capture it so the turn fails on the flag, not on matching
  // one of several apology strings that drift and can be template-overridden.
  let syntheticFailure = false;
  const callback = async (
    content: SyntheticFailureAwareContent,
  ): Promise<unknown[]> => {
    if (content.text) responseText += content.text;
    if (content.elizaSyntheticFailure === true) syntheticFailure = true;
    return [];
  };
  const timeoutMs =
    typeof turn.timeoutMs === "number" ? turn.timeoutMs : turnTimeoutMs;

  const result = await withTimeout(
    messageService.handleMessage(runtime, message, callback, {}),
    timeoutMs,
    `handleMessage(${turn.name})`,
  );

  if (!responseText && result?.responseContent?.text) {
    responseText = result.responseContent.text;
  }
  if (result?.responseContent?.elizaSyntheticFailure === true) {
    syntheticFailure = true;
  }

  // Let completed events settle.
  await new Promise((r) => setTimeout(r, 500));

  return { responseText, durationMs: Date.now() - startedAt, syntheticFailure };
}

async function executeActionTurn(
  runtime: AgentRuntime,
  turn: ScenarioTurn,
  room: ScenarioRoomDefinition,
  currentNow: Date,
  turnTimeoutMs: number,
): Promise<{
  responseText: string;
  responseBody: unknown;
  durationMs: number;
}> {
  const actionName =
    typeof turn.actionName === "string" && turn.actionName.trim().length > 0
      ? turn.actionName.trim()
      : turn.content !== null &&
          typeof turn.content === "object" &&
          typeof (turn.content as { action?: unknown }).action === "string"
        ? String((turn.content as { action: string }).action).trim()
        : "";
  if (!actionName) {
    throw new Error(
      `[executor] action turn '${turn.name}' is missing actionName`,
    );
  }

  const action = runtime.actions.find(
    (candidate: Action) => candidate.name === actionName,
  );
  if (!action) {
    throw new Error(
      `[executor] action turn '${turn.name}' requested unknown action '${actionName}'`,
    );
  }

  const text =
    typeof turn.text === "string"
      ? String(resolveScenarioTemplates(turn.text, currentNow))
      : actionName;
  const turnContent =
    turn.content !== null && typeof turn.content === "object"
      ? (turn.content as Record<string, unknown>)
      : {};
  const message: Memory = createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: room.userId,
    roomId: room.roomId,
    content: {
      ...turnContent,
      action: actionName,
      text,
      source: room.source,
      channelType: room.channelType,
    },
  });
  const options =
    turn.options !== null && typeof turn.options === "object"
      ? (turn.options as Record<string, unknown>)
      : {};
  const startedAt = Date.now();
  let responseText = "";
  const callback = async (content: { text?: string }): Promise<Memory[]> => {
    if (content.text) {
      responseText += content.text;
    }
    return [];
  };
  const timeoutMs =
    typeof turn.timeoutMs === "number" ? turn.timeoutMs : turnTimeoutMs;
  const validated = await withTimeout(
    action.validate(runtime, message, undefined, options as never),
    timeoutMs,
    `validateAction(${turn.name})`,
  );
  if (!validated) {
    throw new Error(
      `[executor] action turn '${turn.name}' failed validation for '${actionName}'`,
    );
  }
  const result = await withTimeout(
    action.handler(
      runtime,
      message,
      undefined,
      options as never,
      callback as never,
    ),
    timeoutMs,
    `executeAction(${turn.name})`,
  );
  const actionResult = result as ActionResult | undefined;
  if (
    !responseText &&
    actionResult?.verifiedUserFacing === true &&
    typeof actionResult.userFacingText === "string"
  ) {
    responseText = actionResult.userFacingText;
  }
  if (!responseText && typeof actionResult?.text === "string") {
    responseText = actionResult.text;
  }
  if (!responseText && typeof actionResult?.userFacingText === "string") {
    responseText = actionResult.userFacingText;
  }
  return {
    responseText,
    responseBody: actionResult ?? null,
    durationMs: Date.now() - startedAt,
  };
}

async function executeApiTurn(args: {
  turn: ScenarioTurn;
  apiServer: ScenarioApiServer;
  variables: ScenarioVariableState;
  turnTimeoutMs: number;
}): Promise<{
  apiStatus: number;
  apiBody: unknown;
  statusCode: number;
  responseBody: unknown;
  responseText: string;
  reportResponseText: string;
  durationMs: number;
}> {
  const method =
    typeof args.turn.method === "string" && args.turn.method.trim().length > 0
      ? args.turn.method.trim().toUpperCase()
      : "GET";
  const rawPath =
    typeof args.turn.path === "string" && args.turn.path.trim().length > 0
      ? args.turn.path.trim()
      : null;
  if (!rawPath) {
    throw new Error(`[executor] api turn '${args.turn.name}' is missing path`);
  }
  const path = await resolveTemplateString({
    value: rawPath,
    apiServer: args.apiServer,
    variables: args.variables,
  });
  const body =
    args.turn.body === undefined
      ? undefined
      : await resolveTemplateValue({
          value: args.turn.body,
          apiServer: args.apiServer,
          variables: args.variables,
        });

  const startedAt = Date.now();
  const timeoutMs =
    typeof args.turn.timeoutMs === "number"
      ? args.turn.timeoutMs
      : args.turnTimeoutMs;
  const response = await withTimeout(
    fetch(`${args.apiServer.baseUrl}${path}`, {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    timeoutMs,
    `api(${args.turn.name})`,
  );
  const responseText = await response.text();
  let responseBody: unknown = responseText;
  const contentType = response.headers.get("content-type") ?? "";
  if (responseText.length > 0 && contentType.includes("application/json")) {
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = responseText;
    }
  }
  indexResponseIdentifiers(responseBody, args.variables);
  captureResponseFields(args.turn, responseBody, args.variables);
  const explicitRedactions = Array.isArray(args.turn.redactResponseFields)
    ? args.turn.redactResponseFields.filter(
        (field): field is string => typeof field === "string",
      )
    : [];
  const reportResponseBody = redactForScenarioReport(
    responseBody,
    explicitRedactions,
  );

  return {
    apiStatus: response.status,
    apiBody: responseBody,
    statusCode: response.status,
    responseBody,
    responseText:
      typeof responseBody === "string"
        ? responseBody
        : JSON.stringify(responseBody ?? ""),
    reportResponseText:
      typeof reportResponseBody === "string"
        ? reportResponseBody
        : JSON.stringify(reportResponseBody ?? ""),
    durationMs: Date.now() - startedAt,
  };
}

async function executeTickTurn(args: {
  turn: ScenarioTurn;
  apiServer: ScenarioApiServer;
  variables: ScenarioVariableState;
  turnTimeoutMs: number;
  runtime: AgentRuntime;
}): Promise<{
  statusCode: number;
  responseBody: unknown;
  responseText: string;
  durationMs: number;
}> {
  const worker =
    typeof args.turn.worker === "string" && args.turn.worker.trim().length > 0
      ? args.turn.worker.trim()
      : null;
  if (worker !== "lifeops_scheduler") {
    throw new Error(
      `[executor] tick turn '${args.turn.name}' has unsupported worker '${worker ?? "(missing)"}'`,
    );
  }

  const options = await resolveTemplateValue({
    value: args.turn.options ?? {},
    apiServer: args.apiServer,
    variables: args.variables,
  });
  const now =
    typeof args.turn.now === "string"
      ? await resolveTemplateString({
          value: args.turn.now,
          apiServer: args.apiServer,
          variables: args.variables,
        })
      : undefined;
  const startedAt = Date.now();
  const { executeLifeOpsSchedulerTask } = (await import(
    "@elizaos/plugin-personal-assistant/plugin"
  )) as {
    executeLifeOpsSchedulerTask: (
      runtime: AgentRuntime,
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
  const result = await withTimeout(
    executeLifeOpsSchedulerTask(args.runtime, {
      ...(toRecord(options) ?? {}),
      ...(now ? { now } : {}),
    }),
    typeof args.turn.timeoutMs === "number"
      ? args.turn.timeoutMs
      : args.turnTimeoutMs,
    `tick(${args.turn.name})`,
  );
  const responseBody = { success: true, ...result };
  return {
    statusCode: 200,
    responseBody,
    responseText: JSON.stringify(responseBody),
    durationMs: Date.now() - startedAt,
  };
}

async function executeWaitTurn(
  turn: ScenarioTurn,
  turnTimeoutMs: number,
): Promise<{
  statusCode: number;
  responseBody: unknown;
  responseText: string;
  durationMs: number;
}> {
  const durationMs = (turn as { durationMs?: unknown }).durationMs;
  if (
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    throw new Error(
      `[executor] wait turn '${turn.name}' requires non-negative durationMs`,
    );
  }
  const timeoutMs =
    typeof turn.timeoutMs === "number" ? turn.timeoutMs : turnTimeoutMs;
  const startedAt = Date.now();
  await withTimeout(
    new Promise((resolve) => setTimeout(resolve, durationMs)),
    timeoutMs,
    `wait(${turn.name})`,
  );
  const responseBody = { success: true, durationMs };
  return {
    statusCode: 200,
    responseBody,
    responseText: JSON.stringify(responseBody),
    durationMs: Date.now() - startedAt,
  };
}

function turnUsesStatusResponse(turnKind: string): boolean {
  return turnKind === "api" || turnKind === "tick" || turnKind === "wait";
}

interface TurnAssertionResult {
  failures: string[];
  /** Numeric `responseJudge` score when the turn ran an LLM judge (#8795). */
  judgeScore?: number;
}

async function runTurnAssertions(
  turn: ScenarioTurn,
  execution: ExecutedTurn,
  runtime: AgentRuntime,
  minJudgeScore: number,
): Promise<TurnAssertionResult> {
  const failures: string[] = [];
  let judgeScore: number | undefined;
  const kind = typeof turn.kind === "string" ? turn.kind : "message";

  if (execution.syntheticFailure === true) {
    failures.push(
      "runtimeFailureReply: the runtime returned a synthetic model/runtime failure reply (rate-limit, auth, credits, or generic apology); this cannot satisfy scenario evidence",
    );
  }

  if (typeof turn.assertResponse === "function") {
    const result = turnUsesStatusResponse(kind)
      ? await (
          turn.assertResponse as (status: number, body: unknown) => unknown
        )(execution.statusCode ?? 0, execution.responseBody)
      : await (turn.assertResponse as (text: string) => unknown)(
          execution.responseText ?? "",
        );
    if (typeof result === "string" && result.length > 0) {
      failures.push(`assertResponse: ${result}`);
    }
  }

  if (turnUsesStatusResponse(kind)) {
    const expectedStatus = (turn as { expectedStatus: number }).expectedStatus;
    if (
      typeof expectedStatus === "number" &&
      execution.statusCode !== expectedStatus
    ) {
      failures.push(
        `expectedStatus: expected ${expectedStatus}, saw ${execution.statusCode ?? "unknown"}`,
      );
    }
  }

  if (kind === "voice") {
    // A voice turn fails when the scored run regressed or silently skipped.
    // Optional/manual voice coverage must opt in with allowVoiceSkip.
    failures.push(
      ...voiceTurnAssertionFailures(
        execution.responseBody as VoiceWorkbenchScenarioRun | undefined,
        { allowVoiceSkip: turn.allowVoiceSkip === true },
      ),
    );
  }

  if (typeof turn.assertTurn === "function") {
    const result = await turn.assertTurn(execution);
    if (typeof result === "string" && result.length > 0) {
      failures.push(`assertTurn: ${result}`);
    }
  }

  const expectedActions = stringList(
    (turn as { expectedActions?: unknown }).expectedActions,
  );
  if (expectedActions.length > 0) {
    const realActions = execution.actionsCalled.filter(
      (action) => !isSynthesizedReplyAction(action),
    );
    const ok = realActions.some((action) =>
      actionMatchesScenarioExpectation(action.actionName, expectedActions),
    );
    if (!ok) {
      const realActionNames =
        realActions.map((action) => action.actionName).join(",") || "(none)";
      const capturedActionNames =
        execution.actionsCalled.map((action) => action.actionName).join(",") ||
        "(none)";
      const capturedDetail =
        capturedActionNames === realActionNames
          ? ""
          : `; captured actions: [${capturedActionNames}]`;
      failures.push(
        `expectedActions: expected action in [${expectedActions.join(
          ",",
        )}], saw actions [${realActionNames}]${capturedDetail}`,
      );
    }
  }

  // responseIncludesAny / responseIncludesAll / responseExcludes / forbiddenActions (inline)
  const includesAny = (turn as { responseIncludesAny?: unknown })
    .responseIncludesAny;
  if (Array.isArray(includesAny) && includesAny.length > 0) {
    const text = execution.responseText ?? "";
    const ok = includesAny.some((pattern) =>
      responsePatternMatches(pattern, text),
    );
    if (!ok) {
      failures.push(
        `responseIncludesAny: expected response to include any of [${includesAny.join(
          ",",
        )}], saw ${JSON.stringify(execution.responseText ?? "")}`,
      );
    }
  }
  const includesAll = (turn as { responseIncludesAll?: unknown })
    .responseIncludesAll;
  if (Array.isArray(includesAll) && includesAll.length > 0) {
    const text = execution.responseText ?? "";
    const missing = includesAll.filter(
      (pattern) => !responsePatternMatches(pattern, text),
    );
    if (missing.length > 0) {
      failures.push(
        `responseIncludesAll: expected response to include all of [${includesAll.join(
          ",",
        )}], missing [${missing.join(",")}], saw ${JSON.stringify(
          execution.responseText ?? "",
        )}`,
      );
    }
  }
  const excludes = (turn as { responseExcludes?: unknown }).responseExcludes;
  if (Array.isArray(excludes) && excludes.length > 0) {
    const text = execution.responseText ?? "";
    const hits = excludes.filter((pattern) =>
      responsePatternMatches(pattern, text),
    );
    if (hits.length > 0) {
      failures.push(
        `responseExcludes: response included forbidden pattern(s) [${hits.join(
          ",",
        )}], saw ${JSON.stringify(execution.responseText ?? "")}`,
      );
    }
  }
  const forbidden = (turn as { forbiddenActions?: unknown }).forbiddenActions;
  if (Array.isArray(forbidden) && forbidden.length > 0) {
    const hits = execution.actionsCalled.filter((a) =>
      forbidden.includes(a.actionName),
    );
    if (hits.length > 0) {
      failures.push(
        `forbiddenActions triggered: ${hits.map((h) => h.actionName).join(",")}`,
      );
    }
  }
  const plannerIncludesAll = toTurnMatcherArray(
    (turn as { plannerIncludesAll?: unknown }).plannerIncludesAll,
  );
  const plannerIncludesAny = toTurnMatcherArray(
    (turn as { plannerIncludesAny?: unknown }).plannerIncludesAny,
  );
  const plannerExcludes = toTurnMatcherArray(
    (turn as { plannerExcludes?: unknown }).plannerExcludes,
  );
  if (
    plannerIncludesAll.length > 0 ||
    plannerIncludesAny.length > 0 ||
    plannerExcludes.length > 0
  ) {
    const plannerBlob = buildPlannerAssertionBlob(execution);
    const plannerPreview = JSON.stringify(plannerBlob.slice(0, 500));
    if (plannerIncludesAll.length > 0) {
      const missing = plannerIncludesAll.filter(
        (pattern) => !matchesTurnMatcher(plannerBlob, pattern),
      );
      if (missing.length > 0) {
        failures.push(
          `plannerIncludesAll: expected planner trace to include ${formatTurnMatcher(
            missing[0] as TurnMatcher,
          )}, saw ${plannerPreview}`,
        );
      }
    }
    if (plannerIncludesAny.length > 0) {
      const ok = plannerIncludesAny.some((pattern) =>
        matchesTurnMatcher(plannerBlob, pattern),
      );
      if (!ok) {
        failures.push(
          `plannerIncludesAny: expected planner trace to include any of [${formatTurnMatchers(
            plannerIncludesAny,
          )}], saw ${plannerPreview}`,
        );
      }
    }
    if (plannerExcludes.length > 0) {
      const hits = plannerExcludes.filter((pattern) =>
        matchesTurnMatcher(plannerBlob, pattern),
      );
      if (hits.length > 0) {
        failures.push(
          `plannerExcludes: expected planner trace to exclude [${formatTurnMatchers(
            hits,
          )}], saw ${plannerPreview}`,
        );
      }
    }
  }

  if (turn.responseJudge) {
    const rubric = turn.responseJudge as ScenarioJudgeRubric;
    const threshold = rubric.minimumScore ?? minJudgeScore;
    try {
      const judged = await judgeTextWithLlm(
        runtime,
        buildExecutionJudgeCandidate(turn, execution),
        rubric.rubric,
      );
      judgeScore = judged.score;
      if (judged.score < threshold) {
        failures.push(
          `responseJudge: score ${judged.score.toFixed(2)} < ${threshold}: ${judged.reason}`,
        );
      }
    } catch (err) {
      failures.push(
        `responseJudge: judge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { failures, ...(judgeScore !== undefined ? { judgeScore } : {}) };
}

async function runJudgeRubricFinalCheck(
  check: ScenarioFinalCheck,
  scenario: ScenarioDefinition,
  runtime: AgentRuntime,
  ctx: RunnerContext,
  minJudgeScore: number,
): Promise<FinalCheckReport> {
  const { name, rubric, minimumScore } = check as {
    name?: string;
    rubric?: string;
    minimumScore?: number;
  };
  const threshold = minimumScore ?? minJudgeScore;
  const candidate = buildScenarioJudgeCandidate(scenario, ctx);
  if (typeof rubric !== "string" || rubric.length === 0) {
    return {
      label: name ?? "judgeRubric",
      type: "judgeRubric",
      status: "failed",
      detail: "judgeRubric final check missing rubric string",
    };
  }
  try {
    const judged = await judgeTextWithLlm(runtime, candidate, rubric);
    if (judged.score < threshold) {
      return {
        label: name ?? "judgeRubric",
        type: "judgeRubric",
        status: "failed",
        detail: `score ${judged.score.toFixed(2)} < ${threshold}: ${judged.reason}`,
        score: judged.score,
      };
    }
    return {
      label: name ?? "judgeRubric",
      type: "judgeRubric",
      status: "passed",
      detail: `score ${judged.score.toFixed(2)} ≥ ${threshold}`,
      score: judged.score,
    };
  } catch (err) {
    return {
      label: name ?? "judgeRubric",
      type: "judgeRubric",
      status: "failed",
      detail: `judge failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runScenario(
  scenario: ScenarioDefinition,
  runtime: AgentRuntime,
  opts: ExecutorOptions,
): Promise<ScenarioReport> {
  const startedAt = Date.now();
  let logicalNow = new Date();
  const ctx: RunnerContext = {
    scenarioId: scenario.id,
    ...(process.env.ELIZA_LIFEOPS_RUN_ID
      ? { runId: process.env.ELIZA_LIFEOPS_RUN_ID }
      : {}),
    now: logicalNow.toISOString(),
    actionsCalled: [],
    turns: [],
    approvalRequests: [],
    connectorDispatches: [],
    memoryWrites: [],
    stateTransitions: [],
    artifacts: [],
  };

  const report: ScenarioReport = {
    id: scenario.id,
    title: scenario.title,
    domain: scenario.domain,
    tags: Array.isArray(scenario.tags)
      ? scenario.tags.filter((t): t is string => typeof t === "string")
      : [],
    ...(typeof scenario.tier === "string" ? { tier: scenario.tier } : {}),
    status: "passed",
    durationMs: 0,
    turns: [],
    finalChecks: [],
    actionsCalled: [],
    failedAssertions: [],
    providerName: opts.providerName,
  };
  // Every numeric LLM-judge score produced while running this scenario (turn
  // responseJudge + judgeRubric final checks). The minimum — the binding
  // quality constraint — is serialized as report.judgeScore (#8795).
  const judgeScores: number[] = [];

  let interceptor = attachInterceptor(runtime);
  const rooms = resolveScenarioRooms(scenario);
  const primaryRoom = getDefaultScenarioRoom(rooms);
  // Expose the owner conversation identity to seeds and custom checks:
  // plain-text memory seeds write durable facts attributed to this room +
  // entity so the core FACTS provider can surface them during turns.
  ctx.primaryRoomId = primaryRoom.roomId;
  ctx.primaryUserId = primaryRoom.userId;
  const variables: ScenarioVariableState = {
    baseNow: new Date(startedAt),
    capturesByName: new Map<string, unknown>(),
    definitionIdsByTitle: new Map<string, string>(),
    occurrenceIdsByTitle: new Map<string, string>(),
  };
  const originalGetService = runtime.getService.bind(runtime);
  const scenarioComputerUseService = createScenarioComputerUseService();
  let apiServer: ScenarioApiServer | null = null;

  try {
    resetScenarioLlmFixtures(runtime);

    runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", primaryRoom.userId, false);
    (
      runtime as {
        getService: AgentRuntime["getService"];
      }
    ).getService = ((serviceType: string) => {
      const existing = originalGetService(serviceType);
      if (existing !== null && existing !== undefined) {
        return existing;
      }
      if (serviceType === "computeruse") {
        return scenarioComputerUseService;
      }
      return existing;
    }) as AgentRuntime["getService"];

    for (const room of rooms) {
      await runtime.ensureConnection({
        entityId: room.userId,
        roomId: room.roomId,
        worldId: room.worldId,
        userName: room.userName,
        source: room.source,
        channelId: room.roomId,
        type: room.channelType,
      });
    }

    const seedResult = await runCustomSeeds(scenario, runtime, ctx, logicalNow);
    logicalNow = seedResult.now;
    variables.baseNow = new Date(logicalNow);
    ctx.now = logicalNow.toISOString();
    if (seedResult.error) {
      report.status = "failed";
      report.error = seedResult.error;
      report.durationMs = Date.now() - startedAt;
      return report;
    }

    // Seeds may register fixture plugins, so check declared plugin requirements
    // after seeding and try to load package-named requirements that are present.
    const requiredPlugins = resolveRequiredPlugins(scenario);
    // Track packages we successfully auto-loaded: a plugin's internal
    // `plugin.name` often differs from its package name (e.g. "plugin-health",
    // "@elizaos/plugin-linear-ts"), so a post-load name check can falsely report
    // it as missing and skip a scenario whose required plugin is in fact loaded.
    const autoLoaded = new Set<string>();
    for (const pkg of requiredPlugins) {
      if (!pkg.startsWith("@")) continue;
      if (pluginIsRegistered(runtime, pkg)) continue;
      try {
        const candidate = await loadRequiredPlugin(pkg);
        if (candidate) {
          await runtime.registerPlugin(candidate);
          autoLoaded.add(pkg);
        }
      } catch (err) {
        logger.debug(
          `[scenario-runner] failed to auto-load required plugin ${pkg}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const missing = requiredPlugins.filter(
      (p) => !pluginIsRegistered(runtime, p) && !autoLoaded.has(p),
    );
    if (missing.length > 0) {
      report.status = "skipped";
      report.skipReason = `required plugin(s) not registered: ${missing.join(",")}`;
      return report;
    }

    // Re-attach interceptor so any actions registered by seed plugins are wrapped.
    interceptor.detach();
    interceptor = attachInterceptor(runtime);
    apiServer = await startScenarioApiServer(runtime);
    const activeApiServer = apiServer;
    ctx.apiBaseUrl = activeApiServer.baseUrl;

    for (const turn of scenario.turns) {
      const kind = typeof turn.kind === "string" ? turn.kind : "message";
      if (
        kind !== "message" &&
        kind !== "action" &&
        kind !== "api" &&
        kind !== "tick" &&
        kind !== "wait" &&
        kind !== "voice"
      ) {
        report.turns.push({
          name: turn.name,
          kind,
          text: typeof turn.text === "string" ? turn.text : undefined,
          responseText: "",
          actionsCalled: [],
          durationMs: 0,
          failedAssertions: [
            `turn kind '${kind}' is not supported by this runner`,
          ],
        });
        report.status = "failed";
        continue;
      }

      const actionsBefore = interceptor.actions.length;
      const execution: ExecutedTurn =
        kind === "voice"
          ? {
              actionsCalled: [],
              ...(await executeVoiceTurn(turn)),
            }
          : kind === "api"
            ? {
                actionsCalled: [],
                ...(await executeApiTurn({
                  turn,
                  apiServer: activeApiServer,
                  variables,
                  turnTimeoutMs: opts.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS,
                })),
              }
            : kind === "tick"
              ? {
                  actionsCalled: [],
                  ...(await executeTickTurn({
                    turn,
                    apiServer: activeApiServer,
                    variables,
                    turnTimeoutMs:
                      opts.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS,
                    runtime,
                  })),
                }
              : kind === "action"
                ? {
                    actionsCalled: [],
                    ...(await executeActionTurn(
                      runtime,
                      turn,
                      resolveTurnRoom(turn, rooms),
                      logicalNow,
                      opts.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS,
                    )),
                  }
                : kind === "wait"
                  ? {
                      actionsCalled: [],
                      ...(await executeWaitTurn(
                        turn,
                        opts.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS,
                      )),
                    }
                  : {
                      actionsCalled: [],
                      ...(await executeMessageTurn(
                        runtime,
                        turn,
                        resolveTurnRoom(turn, rooms),
                        logicalNow,
                        opts.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS,
                        scenario.id,
                        ctx.runId,
                      )),
                    };
      let actionsThisTurn = interceptor.actions.slice(actionsBefore);
      // Synthesize an implicit REPLY capture when the runtime emitted text
      // via the message callback but the LLM failed to select REPLY in its
      // structured response. This happens regularly
      // with smaller models (e.g. hosted fast models) on plain conversational
      // turns. The scenario intent is "a conversational reply happened" —
      // without this, ~30% of cross-cutting scenarios fail on provider-quirk
      // rather than semantic regression.
      if (
        kind === "message" &&
        actionsThisTurn.length === 0 &&
        typeof execution.responseText === "string" &&
        execution.responseText.trim().length > 0
      ) {
        const synthesizedReply: CapturedAction = {
          actionName: "REPLY",
          parameters: undefined,
          result: {
            // Do NOT claim success: this entry is fabricated because the LLM
            // failed to select an action, so it must not satisfy a
            // status:"success" actionCalled assertion. The `source` marker lets
            // final-checks (and the native export) tell it apart from a real
            // LLM-selected REPLY so it cannot mask a genuine selection failure.
            text: execution.responseText,
            data: { source: "synthesized-reply" },
          },
        };
        interceptor.actions.push(synthesizedReply);
        actionsThisTurn = [synthesizedReply];
      }
      execution.actionsCalled = actionsThisTurn;
      ctx.turns.push(execution);

      const { failures: failedAssertions, judgeScore: turnJudgeScore } =
        await runTurnAssertions(turn, execution, runtime, opts.minJudgeScore);
      if (turnJudgeScore !== undefined) {
        judgeScores.push(turnJudgeScore);
      }
      const voiceRun =
        kind === "voice"
          ? (execution.responseBody as VoiceWorkbenchScenarioRun | undefined)
          : undefined;
      report.turns.push({
        name: turn.name,
        kind,
        text: typeof turn.text === "string" ? turn.text : undefined,
        responseText:
          execution.reportResponseText ?? execution.responseText ?? "",
        actionsCalled: actionsThisTurn,
        durationMs: execution.durationMs ?? 0,
        failedAssertions,
        ...(turnJudgeScore !== undefined ? { judgeScore: turnJudgeScore } : {}),
        ...(voiceRun?.audioArtifacts && voiceRun.audioArtifacts.length > 0
          ? { audioArtifacts: voiceRun.audioArtifacts }
          : {}),
      });
      if (failedAssertions.length > 0) {
        report.status = "failed";
        for (const detail of failedAssertions) {
          report.failedAssertions.push({ label: turn.name, detail });
        }
      }
    }

    ctx.actionsCalled = interceptor.actions;
    ctx.approvalRequests = interceptor.approvalRequests;
    ctx.connectorDispatches = interceptor.connectorDispatches;
    ctx.memoryWrites = interceptor.memoryWrites;
    ctx.stateTransitions = interceptor.stateTransitions;
    ctx.artifacts = interceptor.artifacts;
    report.actionsCalled = [...interceptor.actions];

    const finalChecks = Array.isArray(
      (scenario as { finalChecks?: unknown }).finalChecks,
    )
      ? ((scenario as { finalChecks: ScenarioFinalCheck[] }).finalChecks ?? [])
      : [];
    for (const check of finalChecks) {
      const type = (check as { type?: string }).type ?? "unknown";
      let result: FinalCheckReport;
      if (type === "judgeRubric") {
        result = await runJudgeRubricFinalCheck(
          check,
          scenario,
          runtime,
          ctx,
          opts.minJudgeScore,
        );
      } else {
        result = await runFinalCheck(check, { runtime, ctx });
      }
      report.finalChecks.push(result);
      if (typeof result.score === "number") {
        judgeScores.push(result.score);
      }
      if (result.status === "failed") {
        report.status = "failed";
        report.failedAssertions.push({
          label: result.label,
          detail: result.detail,
        });
      } else if (result.status === "skipped") {
        const failure = skippedFinalCheckFailure(
          scenarioLane(scenario),
          result,
        );
        if (failure) {
          report.status = "failed";
          report.failedAssertions.push({
            label: result.label,
            detail: failure,
          });
        } else {
          logger.warn(
            `[scenario-runner] ${scenario.id} finalCheck "${result.label}" skipped — ${result.detail}. This check proved nothing this run.`,
          );
        }
      }
    }

    const fixtureFailure = assertScenarioLlmFixturesConsumed(runtime);
    if (fixtureFailure) {
      report.status = "failed";
      report.failedAssertions.push({
        label: "llmFixtures",
        detail: fixtureFailure,
      });
    }
  } catch (err) {
    report.status = "failed";
    report.error = err instanceof Error ? err.message : String(err);
    logger.warn(`[scenario-runner] ${scenario.id} threw: ${report.error}`);
  } finally {
    const cleanupFailures = await runScenarioCleanups(scenario, runtime, ctx);
    if (cleanupFailures.length > 0) {
      report.status = "failed";
      for (const detail of cleanupFailures) {
        report.failedAssertions.push({ label: "cleanup", detail });
      }
    }
    (
      runtime as {
        getService: AgentRuntime["getService"];
      }
    ).getService = originalGetService as AgentRuntime["getService"];
    interceptor.detach();
    if (apiServer) {
      await apiServer.close();
    }
    report.durationMs = Date.now() - startedAt;
  }

  if (judgeScores.length > 0) {
    report.judgeScore = Math.min(...judgeScores);
    // Judge-independence governance (#9310): a judge score produced without
    // independent judge credentials (and outside the deterministic-proxy
    // fixture lanes) came from the model under test grading itself. Stamp it
    // fail-loud-visible; strict mode turns it into a failure.
    if (!deterministicJudgeFixturesActive() && !(await isJudgeIndependent())) {
      report.judgeSelfGraded = true;
      logger.warn(
        `[scenario-runner] ${scenario.id}: judge scores were produced by the model under test (self-graded) — set CEREBRAS_API_KEY for an independent judge`,
      );
      if (judgeIndependenceRequired()) {
        report.status = "failed";
        report.failedAssertions.push({
          label: "judgeIndependence",
          detail:
            "SCENARIO_JUDGE_REQUIRE_INDEPENDENT=1: judge scores came from the model under test (self-graded); configure CEREBRAS_API_KEY / EVAL_CEREBRAS_API_KEY so scenarios are graded independently",
        });
      }
    }
  }
  return report;
}
