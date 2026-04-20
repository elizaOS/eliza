/**
 * Executes one scenario end-to-end against a live runtime:
 *   1. Check `requires` gates — skip with reason if a required plugin/credential
 *      isn't available.
 *   2. Run seed steps, including logical-clock steps like `advanceClock`.
 *   3. For each turn: execute `message`, `api`, or `tick`, capture response
 *      text/body/actions, and run per-turn assertions/judges.
 *   4. Run `finalChecks` via the handler registry.
 *   5. Aggregate + return a ScenarioReport.
 */

import crypto from "node:crypto";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  ChannelType,
  createMessageMemory,
  logger,
  stringToUuid,
} from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioDefinition,
  ScenarioFinalCheck,
  ScenarioJudgeRubric,
  ScenarioTurn,
  ScenarioTurnExecution,
} from "@elizaos/scenario-schema";
import { runFinalCheck } from "./final-checks/index.ts";
import {
  attachInterceptor,
  ensureInterceptorRuntimeHooks,
} from "./interceptor.ts";
import { judgeTextWithLlm } from "./judge.ts";
import { applyScenarioSeedStep } from "./seeds.ts";
import type {
  FinalCheckReport,
  RunnerContext,
  ScenarioReport,
  TurnReport,
} from "./types.ts";

export interface ExecutorOptions {
  providerName: string;
  minJudgeScore: number;
  turnTimeoutMs: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

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
  const plugins = (runtime as { plugins?: Array<{ name?: unknown }> }).plugins ?? [];
  const normalized = name.replace(/^@elizaos\/plugin-/, "");
  return plugins.some((p) => {
    const pn = typeof p.name === "string" ? p.name : "";
    return pn === name || pn === normalized;
  });
}

const NOW_TEMPLATE_RE = /\{\{now(?:([+-])(\d+)([mhdw]))?\}\}/g;

function addClockOffset(base: Date, by: string): Date {
  const match = /^(\d+)([mhdw])$/i.exec(by.trim());
  if (!match) {
    throw new Error(
      `[scenario-runner] invalid advanceClock offset '${by}' (expected e.g. 10m, 6h, 2d, 1w)`,
    );
  }
  const amountRaw = match[1];
  const unitRaw = match[2];
  if (!amountRaw || !unitRaw) {
    throw new Error(
      `[scenario-runner] invalid advanceClock offset '${by}'`,
    );
  }
  const amount = Number.parseInt(amountRaw, 10);
  const unit = unitRaw.toLowerCase();
  const multipliers: Record<string, number> = {
    m: 60_000,
    h: 60 * 60_000,
    d: 24 * 60 * 60_000,
    w: 7 * 24 * 60 * 60_000,
  };
  return new Date(base.getTime() + amount * multipliers[unit]!);
}

function resolveNowTemplate(
  template: string,
  currentNow: Date,
): string {
  return template.replace(
    NOW_TEMPLATE_RE,
    (_full, sign: string | undefined, amountRaw: string | undefined, unit: string | undefined) => {
      if (!sign || !amountRaw || !unit) {
        return currentNow.toISOString();
      }
      const amount = Number.parseInt(amountRaw, 10);
      const multipliers: Record<string, number> = {
        m: 60_000,
        h: 60 * 60_000,
        d: 24 * 60 * 60_000,
        w: 7 * 24 * 60 * 60_000,
      };
      const multiplier = multipliers[unit.toLowerCase()];
      if (!multiplier) {
        throw new Error(
          `[scenario-runner] unsupported now template unit '${unit}' in '${template}'`,
        );
      }
      const deltaMs = amount * multiplier * (sign === "-" ? -1 : 1);
      return new Date(currentNow.getTime() + deltaMs).toISOString();
    },
  );
}

function resolveScenarioTemplates<T>(value: T, currentNow: Date): T {
  if (typeof value === "string") {
    return resolveNowTemplate(value, currentNow) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      resolveScenarioTemplates(entry, currentNow),
    ) as T;
  }
  if (value && typeof value === "object") {
    if (value instanceof Date) {
      return value;
    }
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      resolved[key] = resolveScenarioTemplates(entry, currentNow);
    }
    return resolved as T;
  }
  return value;
}

function normalizeResponseText(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  return JSON.stringify(body ?? "");
}

type SeedRunResult = {
  now: Date;
  error?: string;
};

type ScenarioRoomRuntime = {
  key: string;
  roomId: UUID;
  source: string;
  channelType: ChannelType;
  title: string;
};

function parseChannelType(value: unknown): ChannelType {
  return value === ChannelType.GROUP ||
    value === ChannelType.FORUM ||
    value === ChannelType.API ||
    value === ChannelType.FEED ||
    value === ChannelType.SELF
    ? value
    : ChannelType.DM;
}

function buildScenarioRooms(scenario: ScenarioDefinition): ScenarioRoomRuntime[] {
  const declaredRooms = (scenario as { rooms?: unknown }).rooms;
  if (!Array.isArray(declaredRooms) || declaredRooms.length === 0) {
    return [
      {
        key: "main",
        roomId: crypto.randomUUID() as UUID,
        source: "scenario-runner",
        channelType: ChannelType.DM,
        title: "Scenario Room",
      },
    ];
  }

  const rooms: ScenarioRoomRuntime[] = [];
  for (const entry of declaredRooms) {
    if (!entry || typeof entry !== "object") continue;
    const room = entry as Record<string, unknown>;
    const key =
      typeof room.id === "string" && room.id.trim().length > 0
        ? room.id.trim()
        : `room-${rooms.length + 1}`;
    rooms.push({
      key,
      roomId: crypto.randomUUID() as UUID,
      source:
        typeof room.source === "string" && room.source.trim().length > 0
          ? room.source.trim()
          : "scenario-runner",
      channelType: parseChannelType(room.channelType),
      title:
        typeof room.title === "string" && room.title.trim().length > 0
          ? room.title.trim()
          : key,
    });
  }

  return rooms.length > 0
    ? rooms
    : [
        {
          key: "main",
          roomId: crypto.randomUUID() as UUID,
          source: "scenario-runner",
          channelType: ChannelType.DM,
          title: "Scenario Room",
        },
      ];
}

function resolveTurnRoom(
  turn: ScenarioTurn,
  rooms: readonly ScenarioRoomRuntime[],
): ScenarioRoomRuntime {
  const requestedKey =
    typeof (turn as { room?: unknown }).room === "string"
      ? (turn as { room: string }).room
      : "main";
  return rooms.find((room) => room.key === requestedKey) ?? rooms[0]!;
}

async function ensureScenarioWorldOwnership(
  runtime: AgentRuntime,
  worldId: UUID,
  ownerId: UUID,
  worldName: string,
): Promise<void> {
  const metadata = {
    ownership: { ownerId },
    roles: { [ownerId]: "OWNER" },
    roleSources: { [ownerId]: "owner" },
  };
  const runtimeWithWorldBootstrap = runtime as AgentRuntime & {
    ensureWorldExists?: (world: {
      id: UUID;
      name: string;
      agentId: UUID;
      messageServerId: UUID;
      metadata: typeof metadata;
    }) => Promise<void>;
    getWorld?: (id: UUID) => Promise<{
      id: UUID;
      metadata?: Record<string, unknown>;
    } | null>;
    updateWorld?: (world: {
      id: UUID;
      metadata?: Record<string, unknown>;
    }) => Promise<void>;
  };

  if (typeof runtimeWithWorldBootstrap.ensureWorldExists === "function") {
    await runtimeWithWorldBootstrap.ensureWorldExists({
      id: worldId,
      name: worldName,
      agentId: runtime.agentId,
      messageServerId: ownerId,
      metadata,
    });
    return;
  }

  if (
    typeof runtimeWithWorldBootstrap.getWorld !== "function" ||
    typeof runtimeWithWorldBootstrap.updateWorld !== "function"
  ) {
    return;
  }

  const world = await runtimeWithWorldBootstrap.getWorld(worldId);
  if (!world) return;
  const currentMetadata =
    world.metadata && typeof world.metadata === "object" ? world.metadata : {};
  world.metadata = {
    ...currentMetadata,
    ownership: { ownerId },
    roles: {
      ...(currentMetadata.roles as Record<string, string> | undefined),
      [ownerId]: "OWNER",
    },
    roleSources: {
      ...(currentMetadata.roleSources as Record<string, string> | undefined),
      [ownerId]: "owner",
    },
  };
  await runtimeWithWorldBootstrap.updateWorld(world);
}

async function runSeedSteps(
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
    const resolvedSeed = resolveScenarioTemplates(seed, currentNow) as typeof seed;
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
          return { now: currentNow, error: `seed ${name ?? "(unnamed)"}: ${result}` };
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
        return { now: currentNow, error: `seed ${name ?? "(unnamed)"}: ${result}` };
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

async function executeMessageTurn(
  runtime: AgentRuntime,
  turn: ScenarioTurn,
  room: ScenarioRoomRuntime,
  userId: UUID,
  currentNow: Date,
): Promise<{ responseText: string; durationMs: number }> {
  const text =
    typeof turn.text === "string"
      ? resolveScenarioTemplates(turn.text, currentNow)
      : "";
  if (text.length === 0) {
    throw new Error(`[executor] turn '${turn.name}' has no text to send`);
  }

  const message: Memory = createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: userId,
    roomId: room.roomId,
    content: {
      text,
      source: room.source,
      channelType: room.channelType,
    },
  });

  const messageService = (runtime as {
    messageService?: {
      handleMessage: (
        rt: AgentRuntime,
        memory: Memory,
        cb: (content: { text?: string }) => Promise<unknown>,
        options?: Record<string, unknown>,
      ) => Promise<{
        responseContent?: { text?: string };
        responseMessages?: Memory[];
      }>;
    };
  }).messageService;
  if (!messageService) {
    throw new Error(
      "[executor] runtime.messageService is not initialized — cannot send messages",
    );
  }

  const startedAt = Date.now();
  let responseText = "";
  const callback = async (content: { text?: string }): Promise<unknown[]> => {
    if (content.text) responseText += content.text;
    return [];
  };
  const timeoutMs =
    typeof turn.timeoutMs === "number" ? turn.timeoutMs : DEFAULT_TURN_TIMEOUT_MS;

  const result = await withTimeout(
    messageService.handleMessage(runtime, message, callback, {}),
    timeoutMs,
    `handleMessage(${turn.name})`,
  );

  if (!responseText && result?.responseContent?.text) {
    responseText = result.responseContent.text;
  }

  // Let completed events settle.
  await new Promise((r) => setTimeout(r, 500));

  return { responseText, durationMs: Date.now() - startedAt };
}

function createResponseRecorder() {
  const headers = new Map<string, string>();
  const chunks: string[] = [];
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(
        name.toLowerCase(),
        Array.isArray(value) ? value.join(",") : String(value),
      );
      return this;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    writeHead(
      statusCode: number,
      headerValues?: Record<string, string | number | readonly string[]>,
    ) {
      this.statusCode = statusCode;
      if (headerValues) {
        for (const [name, value] of Object.entries(headerValues)) {
          this.setHeader(name, value);
        }
      }
      this.headersSent = true;
      return this;
    },
    write(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
      }
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        this.write(chunk);
      }
      this.headersSent = true;
      return this;
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
  };
  return {
    res,
    getBodyText: () => chunks.join(""),
  };
}

async function executeApiTurn(
  runtime: AgentRuntime,
  turn: ScenarioTurn,
  currentNow: Date,
): Promise<{
  responseText: string;
  responseBody: unknown;
  statusCode: number;
  durationMs: number;
}> {
  const method =
    typeof (turn as { method?: unknown }).method === "string"
      ? ((turn as { method: string }).method.toUpperCase() as string)
      : "GET";
  const rawPath =
    typeof (turn as { path?: unknown }).path === "string"
      ? (turn as { path: string }).path
      : "";
  if (!rawPath) {
    throw new Error(`[executor] api turn '${turn.name}' is missing path`);
  }
  const path = resolveScenarioTemplates(rawPath, currentNow);
  const body = resolveScenarioTemplates(
    (turn as { body?: unknown }).body,
    currentNow,
  );
  const startedAt = Date.now();

  if (!path.startsWith("/api/lifeops")) {
    throw new Error(
      `[executor] api turn '${turn.name}' does not have a supported local path: ${path}`,
    );
  }

  const { handleLifeOpsRoutes } = await import(
    "@elizaos/app-lifeops/routes/lifeops-routes"
  );
  const { res, getBodyText } = createResponseRecorder();
  let recordedBody: unknown = undefined;
  const url = new URL(path, "http://scenario.local");
  const req = {
    method,
    url: url.pathname + url.search,
    headers: {},
  };
  const handled = await handleLifeOpsRoutes({
    req: req as never,
    res: res as never,
    method,
    pathname: url.pathname,
    url,
    state: {
      runtime,
      adminEntityId: null,
    },
    json(response, data, status = 200) {
      recordedBody = data;
      (response as unknown as typeof res).statusCode = status;
      (response as unknown as typeof res).setHeader(
        "content-type",
        "application/json",
      );
      (response as unknown as typeof res).end(JSON.stringify(data));
    },
    error(response, message, status = 500) {
      recordedBody = { error: message };
      (response as unknown as typeof res).statusCode = status;
      (response as unknown as typeof res).setHeader(
        "content-type",
        "application/json",
      );
      (response as unknown as typeof res).end(JSON.stringify(recordedBody));
    },
    async readJsonBody<T extends object>() {
      if (body === undefined) {
        return null;
      }
      return body as T;
    },
    decodePathComponent(raw, _res, _label) {
      return decodeURIComponent(raw);
    },
  });
  if (!handled) {
    throw new Error(
      `[executor] api turn '${turn.name}' was not handled by local routes: ${path}`,
    );
  }
  const responseText =
    recordedBody !== undefined ? normalizeResponseText(recordedBody) : getBodyText();
  if (recordedBody === undefined && responseText.trim().length > 0) {
    try {
      recordedBody = JSON.parse(responseText);
    } catch {
      recordedBody = responseText;
    }
  }
  return {
    responseText,
    responseBody: recordedBody,
    statusCode: res.statusCode,
    durationMs: Date.now() - startedAt,
  };
}

async function executeTickTurn(
  runtime: AgentRuntime,
  turn: ScenarioTurn,
  currentNow: Date,
): Promise<{
  responseText: string;
  responseBody: unknown;
  statusCode: number;
  durationMs: number;
}> {
  const rawWorker =
    typeof (turn as { worker?: unknown }).worker === "string"
      ? (turn as { worker: string }).worker
      : "";
  if (!rawWorker) {
    throw new Error(`[executor] tick turn '${turn.name}' is missing worker`);
  }
  const worker = rawWorker.trim().toLowerCase();
  const resolvedOptions =
    (resolveScenarioTemplates(
      (turn as { options?: unknown }).options ?? {},
      currentNow,
    ) as Record<string, unknown>) ?? {};
  if (!("now" in resolvedOptions)) {
    const explicitNow =
      typeof (turn as { now?: unknown }).now === "string"
        ? resolveScenarioTemplates((turn as { now: string }).now, currentNow)
        : currentNow.toISOString();
    resolvedOptions.now = explicitNow;
  }

  const startedAt = Date.now();
  let result: unknown;
  switch (worker) {
    case "lifeops_scheduler":
    case "lifeops":
    case "scheduler":
    case "lifeops_scheduler_tick": {
      const { executeLifeOpsSchedulerTask } = await import(
        "@elizaos/app-lifeops/lifeops/runtime"
      );
      result = await executeLifeOpsSchedulerTask(runtime, resolvedOptions);
      break;
    }
    case "followup_tracker":
    case "followup":
    case "followup_tracker_reconcile": {
      const { executeFollowupTrackerTick } = await import(
        "../../../apps/app-lifeops/src/followup/followup-tracker.ts"
      );
      result = await executeFollowupTrackerTick(runtime, resolvedOptions);
      break;
    }
    case "proactive_agent":
    case "proactive":
    case "proactive_tick": {
      const { executeProactiveTask } = await import(
        "@elizaos/app-lifeops/activity-profile/proactive-worker"
      );
      result = await executeProactiveTask(runtime, resolvedOptions);
      break;
    }
    default:
      throw new Error(
        `[executor] unsupported tick worker '${rawWorker}' for turn '${turn.name}'`,
      );
  }

  const responseBody =
    result && typeof result === "object"
      ? { success: true, ...(result as Record<string, unknown>) }
      : { success: true, value: result ?? null };
  return {
    responseText: normalizeResponseText(responseBody),
    responseBody,
    statusCode: 200,
    durationMs: Date.now() - startedAt,
  };
}

async function executeWaitTurn(
  turn: ScenarioTurn,
): Promise<{
  responseText: string;
  responseBody: unknown;
  statusCode: number;
  durationMs: number;
}> {
  const durationMs =
    typeof (turn as { durationMs?: unknown }).durationMs === "number"
      ? Math.max(0, (turn as { durationMs: number }).durationMs)
      : 0;
  const startedAt = Date.now();
  if (durationMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  }
  return {
    responseText: "",
    responseBody: { waitedMs: durationMs },
    statusCode: 200,
    durationMs: Date.now() - startedAt,
  };
}

async function runTurnAssertions(
  turn: ScenarioTurn,
  execution: ScenarioTurnExecution,
  runtime: AgentRuntime,
  minJudgeScore: number,
): Promise<string[]> {
  const failures: string[] = [];

  if (typeof turn.assertResponse === "function") {
    const result =
      turn.kind === "api" || turn.kind === "tick"
        ? await (
            turn.assertResponse as (status: number, body: unknown) => unknown
          )(execution.statusCode ?? 0, execution.responseBody)
        : await (
            turn.assertResponse as (text: string) => unknown
          )(execution.responseText ?? "");
    if (typeof result === "string" && result.length > 0) {
      failures.push(`assertResponse: ${result}`);
    }
  }

  if (
    (turn.kind === "api" || turn.kind === "tick") &&
    typeof (turn as { expectedStatus?: unknown }).expectedStatus === "number"
  ) {
    const expectedStatus = (turn as { expectedStatus: number }).expectedStatus;
    if (execution.statusCode !== expectedStatus) {
      failures.push(
        `expectedStatus: expected ${expectedStatus}, saw ${execution.statusCode ?? "unknown"}`,
      );
    }
  }

  if (typeof turn.assertTurn === "function") {
    const result = await turn.assertTurn(execution);
    if (typeof result === "string" && result.length > 0) {
      failures.push(`assertTurn: ${result}`);
    }
  }

  // responseIncludesAny / forbiddenActions / responseIncludesAll (inline)
  const includesAny = (turn as { responseIncludesAny?: unknown })
    .responseIncludesAny;
  if (Array.isArray(includesAny) && includesAny.length > 0) {
    const text = (execution.responseText ?? "").toLowerCase();
    const ok = includesAny.some(
      (p) => typeof p === "string" && text.includes(p.toLowerCase()),
    );
    if (!ok) {
      failures.push(
        `responseIncludesAny: response missing any of [${includesAny.join(",")}]`,
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

  if (turn.responseJudge) {
    const rubric = turn.responseJudge as ScenarioJudgeRubric;
    const threshold = rubric.minimumScore ?? minJudgeScore;
    try {
      const judged = await judgeTextWithLlm(
        runtime,
        execution.responseText ?? "",
        rubric.rubric,
      );
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

  return failures;
}

async function runJudgeRubricFinalCheck(
  check: ScenarioFinalCheck,
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
  const lastTurn = ctx.turns[ctx.turns.length - 1];
  const candidate = lastTurn?.responseText ?? "";
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
      };
    }
    return {
      label: name ?? "judgeRubric",
      type: "judgeRubric",
      status: "passed",
      detail: `score ${judged.score.toFixed(2)} ≥ ${threshold}`,
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
    tags: Array.isArray((scenario as unknown as { tags?: unknown }).tags)
      ? (((scenario as unknown as { tags: unknown[] }).tags).filter(
          (t): t is string => typeof t === "string",
        ) as readonly string[])
      : [],
    status: "passed",
    durationMs: 0,
    turns: [],
    finalChecks: [],
    actionsCalled: [],
    failedAssertions: [],
    providerName: opts.providerName,
  };

  let interceptor = attachInterceptor(runtime);
  const userId = crypto.randomUUID() as UUID;
  const worldId = stringToUuid("scenario-runner-world");
  const rooms = buildScenarioRooms(scenario);
  const worldName = rooms[0]?.title ?? `${scenario.title} World`;

  try {
    await ensureInterceptorRuntimeHooks();
    await ensureScenarioWorldOwnership(runtime, worldId, userId, worldName);
    for (const room of rooms) {
      await runtime.ensureConnection({
        entityId: userId,
        roomId: room.roomId,
        worldId,
        worldName,
        userName: "ScenarioUser",
        name: "ScenarioUser",
        source: room.source,
        channelId: room.roomId,
        type: room.channelType,
        messageServerId: userId,
        metadata: {
          ownership: { ownerId: userId },
          roles: { [userId]: "OWNER" },
          roleSources: { [userId]: "owner" },
        },
      });
    }

    const seedResult = await runSeedSteps(scenario, runtime, ctx, logicalNow);
    logicalNow = seedResult.now;
    ctx.now = logicalNow.toISOString();
    if (seedResult.error) {
      report.status = "failed";
      report.error = seedResult.error;
      report.durationMs = Date.now() - startedAt;
      return report;
    }

    // Requires gate runs AFTER seeds so scenarios that register fixture
    // plugins via a `custom` seed step (e.g. convo.echo-self-test) still
    // satisfy their own declared `requires.plugins`. For package-named
    // plugins (e.g. "@elizaos/plugin-agent-skills") we attempt a dynamic
    // import and register the default export so scenarios don't skip when
    // the plugin is on disk.
    const requiredPlugins = resolveRequiredPlugins(scenario);
    for (const pkg of requiredPlugins) {
      if (!pkg.startsWith("@")) continue;
      if (pluginIsRegistered(runtime, pkg)) continue;
      try {
        const mod = (await import(pkg)) as Record<string, unknown>;
        const candidate = mod.default ?? mod.elizaPlugin ?? mod.plugin;
        if (
          candidate !== null &&
          typeof candidate === "object" &&
          typeof (candidate as { name?: unknown }).name === "string"
        ) {
          await runtime.registerPlugin(
            candidate as unknown as Parameters<
              AgentRuntime["registerPlugin"]
            >[0],
          );
        }
      } catch (err) {
        logger.debug(
          `[scenario-runner] failed to auto-load required plugin ${pkg}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const missing = requiredPlugins.filter(
      (p) => !pluginIsRegistered(runtime, p),
    );
    if (missing.length > 0) {
      report.status = "skipped";
      report.skipReason = `required plugin(s) not registered: ${missing.join(",")}`;
      return report;
    }

    // Re-attach interceptor so any actions registered by seed plugins are wrapped.
    interceptor.detach();
    interceptor = attachInterceptor(runtime);

    for (const turn of scenario.turns) {
      const kind = typeof turn.kind === "string" ? turn.kind : "message";
      const actionsBefore = interceptor.actions.length;
      let responseText = "";
      let responseBody: unknown = undefined;
      let statusCode: number | undefined = undefined;
      let durationMs = 0;
      if (kind === "message") {
        const room = resolveTurnRoom(turn, rooms);
        const result = await executeMessageTurn(
          runtime,
          turn,
          room,
          userId,
          logicalNow,
        );
        responseText = result.responseText;
        durationMs = result.durationMs;
      } else if (kind === "api") {
        const result = await executeApiTurn(runtime, turn, logicalNow);
        responseText = result.responseText;
        responseBody = result.responseBody;
        statusCode = result.statusCode;
        durationMs = result.durationMs;
      } else if (kind === "tick") {
        const result = await executeTickTurn(runtime, turn, logicalNow);
        responseText = result.responseText;
        responseBody = result.responseBody;
        statusCode = result.statusCode;
        durationMs = result.durationMs;
      } else if (kind === "wait") {
        const result = await executeWaitTurn(turn);
        responseText = result.responseText;
        responseBody = result.responseBody;
        statusCode = result.statusCode;
        durationMs = result.durationMs;
      } else {
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
      let actionsThisTurn = interceptor.actions.slice(actionsBefore);
      // Synthesize an implicit REPLY capture when the runtime emitted text to
      // the user but the LLM did not wrap it in an <action> envelope. This
      // preserves the REPLY semantic for scenario assertions without requiring
      // every model to produce the action XML perfectly.
      if (
        kind === "message" &&
        actionsThisTurn.length === 0 &&
        typeof responseText === "string" &&
        responseText.trim().length > 0
      ) {
        const synthesizedReply: CapturedAction = {
          actionName: "REPLY",
          parameters: undefined,
          result: {
            success: true,
            text: responseText,
            data: { source: "synthesized-reply" },
          },
        };
        interceptor.actions.push(synthesizedReply);
        actionsThisTurn = [synthesizedReply];
      }
      const execution: ScenarioTurnExecution = {
        actionsCalled: actionsThisTurn,
        responseText,
        responseBody,
        statusCode,
      };
      ctx.turns.push(execution);

      const failedAssertions = await runTurnAssertions(
        turn,
        execution,
        runtime,
        opts.minJudgeScore,
      );
      report.turns.push({
        name: turn.name,
        kind,
        text: typeof turn.text === "string" ? turn.text : undefined,
        responseText,
        responseBody,
        statusCode,
        actionsCalled: actionsThisTurn,
        durationMs,
        failedAssertions,
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
          runtime,
          ctx,
          opts.minJudgeScore,
        );
      } else {
        result = await runFinalCheck(check, { runtime, ctx });
      }
      report.finalChecks.push(result);
      if (result.status === "failed") {
        report.status = "failed";
        report.failedAssertions.push({
          label: result.label,
          detail: result.detail,
        });
      }
    }
  } catch (err) {
    report.status = "failed";
    report.error = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[scenario-runner] ${scenario.id} threw: ${report.error}`,
    );
  } finally {
    interceptor.detach();
    report.durationMs = Date.now() - startedAt;
  }

  return report;
}
