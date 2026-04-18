/**
 * Action selection benchmark runner.
 *
 * Given a real `AgentRuntime` and a list of `ActionBenchmarkCase`s, send each
 * user message through the runtime, capture the action the agent chose (via
 * the `outgoing_before_deliver` pipeline hook, which surfaces `actionName`
 * for every delivered action), score each case, and produce a report.
 *
 * Designed to be dependency-free beyond the runtime itself — does not assume
 * the Wave 1A action-spy / Wave 1B conversation-harness helpers have landed.
 * If/when they do, this runner can be refactored to use them directly without
 * changing its public API.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

import {
  isTrajectoryCaptureEnabled,
  RecordingHarness,
  type TrajectoryRecord,
} from "../helpers/trajectory-harness.ts";
import type { ActionBenchmarkCase } from "./action-selection-cases.ts";

export type ActionFailureMode =
  | "passed"
  | "validate_filtered"
  | "llm_chose_reply"
  | "llm_chose_other_action"
  | "no_response"
  | "error";

export interface ActionBenchmarkResult {
  case: ActionBenchmarkCase;
  plannerPass?: boolean;
  plannedAction?: string | null;
  plannedActions?: string[];
  startedAction?: string | null;
  completedAction?: string | null;
  actualAction: string | null;
  selectionPass?: boolean;
  executionPass?: boolean;
  pass: boolean;
  latencyMs: number;
  error?: string;
  /** Populated when trajectory capture is enabled (MILADY_DUMP_TRAJECTORIES=1). */
  trajectory?: TrajectoryRecord;
  /** Path to per-case trajectory JSON file when written. */
  trajectoryPath?: string;
  /**
   * Categorized failure mode (or "passed"). Distinguishes the three real
   * failure modes the team needs to debug action selection regressions.
   */
  failureMode?: ActionFailureMode;
  /** Action names whose `validate()` returned false for this case's message. */
  filteredActions?: string[];
  /** Action names that were visible to the planner in the actual prompt. */
  availableActions?: string[];
  /** Snapshot of the runtime's registered action names at benchmark start. */
  registeredActions?: string[];
  /** First ~200 chars of the agent reply, when available. */
  responseText?: string;
}

export interface ActionBenchmarkLatencyStats {
  avg: number;
  p50: number;
  p95: number;
}

export interface ActionBenchmarkTagStats {
  total: number;
  passed: number;
  accuracy: number;
}

export interface ActionBenchmarkReport {
  total: number;
  passed: number;
  failed: number;
  accuracy: number;
  byTag: Record<string, ActionBenchmarkTagStats>;
  latency: ActionBenchmarkLatencyStats;
  failures: ActionBenchmarkResult[];
  results: ActionBenchmarkResult[];
}

export interface ActionBenchmarkRunOptions {
  runtime?: AgentRuntime;
  createCaseRuntime?: () => Promise<{
    runtime: AgentRuntime;
    cleanup: () => Promise<void>;
  }>;
  cases: ActionBenchmarkCase[];
  /**
   * PGLite serializes writes — concurrency > 1 will deadlock on the single
   * local adapter. Defaults to 1 and is only exposed for future remote-DB use.
   */
  concurrency?: number;
  timeoutMsPerCase?: number;
  /**
   * Directory to write per-case trajectory JSON files. Only used when
   * trajectory capture is enabled (`MILADY_DUMP_TRAJECTORIES=1` or the
   * `forceTrajectoryCapture` flag).
   */
  trajectoryDir?: string;
  /** Force trajectory capture even when the env flag is not set. */
  forceTrajectoryCapture?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const BENCHMARK_SOURCE = "dashboard";
const BENCHMARK_USER_NAME = "Owner";
const RETRYABLE_CASE_ATTEMPTS = 3;
const RETRYABLE_CASE_BACKOFF_MS = 5_000;
const GENERIC_ACTION_NAMES = new Set(["REPLY", "IGNORE", "NONE"]);

function resolveBenchmarkOwnerEntityId(runtime: AgentRuntime): UUID {
  const configured = runtime.getSetting("ELIZA_ADMIN_ENTITY_ID");
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured as UUID;
  }
  return stringToUuid(`${runtime.agentId}-admin-entity`);
}

function normalizeActionName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  return trimmed.toUpperCase().replace(/[\s-]+/g, "_");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableCaseError(error: string | undefined): boolean {
  if (!error) return false;
  return /rate limit|too many requests|tokens per minute|please try again in/i.test(
    error,
  );
}

function caseMatches(
  actual: string | null,
  expected: string | null,
  acceptable: string[] | undefined,
): boolean {
  const actualNorm = normalizeActionName(actual);
  if (expected === null) {
    return (
      actualNorm === null ||
      (actualNorm !== null && GENERIC_ACTION_NAMES.has(actualNorm))
    );
  }
  const expectedNorm = normalizeActionName(expected);
  if (actualNorm !== null && actualNorm === expectedNorm) return true;
  if (!acceptable) return false;
  for (const alt of acceptable) {
    if (actualNorm !== null && normalizeActionName(alt) === actualNorm) {
      return true;
    }
  }
  return false;
}

function firstMatchingActionName(
  names: readonly string[],
  expected: string | null,
  acceptable: string[] | undefined,
): string | null {
  for (const name of names) {
    if (caseMatches(name, expected, acceptable)) {
      return name;
    }
  }
  return null;
}

function isGenericActionName(name: string | null | undefined): boolean {
  const normalized = normalizeActionName(name);
  return normalized !== null && GENERIC_ACTION_NAMES.has(normalized);
}

function pickObservedAction(
  records: ReadonlyArray<{
    phase: "started" | "completed";
    actionName: string;
    actionStatus?: string;
  }>,
  phase: "started" | "completed",
  expected: string | null,
  acceptable: string[] | undefined,
  opts?: { requireSuccessfulCompletion?: boolean },
): string | null {
  const names = records
    .filter((record) => {
      if (record.phase !== phase) return false;
      if (
        opts?.requireSuccessfulCompletion &&
        phase === "completed" &&
        record.actionStatus !== "completed"
      ) {
        return false;
      }
      return true;
    })
    .map((record) => record.actionName)
    .filter((name) => typeof name === "string" && name.trim().length > 0);
  return (
    firstMatchingActionName(names, expected, acceptable) ??
    names.find((name) => !isGenericActionName(name)) ??
    names[0] ??
    null
  );
}

interface TurnCapture {
  firstAction: string | null;
}

/**
 * After the runtime has handled a message, ask each registered action's
 * `validate()` whether it would have accepted that message. Returns the names
 * of actions that returned false (i.e. were filtered out before the LLM saw
 * them). This is what distinguishes "action exists but was hidden" from "LLM
 * picked wrong action".
 */
async function computeFilteredActions(
  runtime: AgentRuntime,
  message: Memory,
): Promise<string[]> {
  const state = await runtime.composeState(message);
  const filtered: string[] = [];
  for (const action of runtime.actions) {
    let ok = false;
    try {
      ok = await action.validate(runtime, message, state);
    } catch {
      // A throwing validator is effectively "filtered out" from the planner's
      // perspective — count it the same way.
      ok = false;
    }
    if (!ok) filtered.push(action.name);
  }
  return filtered;
}

function determineFailureMode(args: {
  pass: boolean;
  expected: string | null;
  actual: string | null;
  planned: string | null;
  filtered: string[];
  hadError: boolean;
}): ActionFailureMode {
  if (args.hadError) return "error";
  if (args.pass) return "passed";
  const actualNorm = normalizeActionName(args.actual);
  const plannedNorm = normalizeActionName(args.planned);
  const expectedNorm = normalizeActionName(args.expected);
  if (
    actualNorm !== null &&
    expectedNorm !== null &&
    actualNorm === expectedNorm
  ) {
    return "passed";
  }
  if (
    expectedNorm !== null &&
    args.filtered.some((n) => normalizeActionName(n) === expectedNorm)
  ) {
    return "validate_filtered";
  }
  if (
    plannedNorm === null ||
    plannedNorm === "REPLY" ||
    plannedNorm === "NONE" ||
    plannedNorm === "IGNORE"
  ) {
    if (actualNorm === null) {
      return "llm_chose_reply";
    }
  }
  if (actualNorm === null && plannedNorm === null) {
    if (
      expectedNorm !== null &&
      args.filtered.some((n) => normalizeActionName(n) === expectedNorm)
    ) {
      return "validate_filtered";
    }
    return "llm_chose_reply";
  }
  return "llm_chose_other_action";
}

interface PlannerDecision {
  availableActions: string[];
  plannedActions: string[];
  plannedAction: string | null;
}

function parseAvailableActionsFromPrompt(prompt: string): string[] {
  const lines = prompt.split("\n");
  const available: string[] = [];
  let inSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!inSection) {
      if (line === "# Available Actions") {
        inSection = true;
      }
      continue;
    }
    if (!line) continue;
    if (line.startsWith("# ") || line.startsWith("## ")) break;
    const match = line.match(/^- ([A-Z0-9_]+):/);
    if (match?.[1]) {
      available.push(match[1]);
    }
  }
  return available;
}

function parsePlannedActionsFromResponse(response: string): string[] {
  const names = Array.from(
    response.matchAll(/<name>\s*([^<]+?)\s*<\/name>/gi),
    (match) => normalizeActionName(match[1]),
  ).filter((name): name is string => name !== null);
  return [...new Set(names)];
}

function extractPlannerDecision(
  trajectory: TrajectoryRecord | undefined,
): PlannerDecision {
  const plannerCall = trajectory?.agentTrajectory.llmCalls.find(
    (call) => call.purpose === "action_planner",
  );
  if (!plannerCall) {
    return {
      availableActions: [],
      plannedActions: [],
      plannedAction: null,
    };
  }
  const availableActions = parseAvailableActionsFromPrompt(plannerCall.prompt);
  const plannedActions = parsePlannedActionsFromResponse(plannerCall.response);
  return {
    availableActions,
    plannedActions,
    plannedAction: plannedActions[0] ?? null,
  };
}

/**
 * Seed the per-case runtime with the fixtures the benchmark cases depend on:
 *   - A pre-existing relationship for "David" (used by rel-follow-up).
 *   - ELIZA_ADMIN_ENTITY_ID settings so hasAdminAccess/hasOwnerAccess return
 *     true for the benchmark user.
 *
 * Called once per case, before the user message is sent. All failures are
 * logged and swallowed so that a seed-level issue on one fixture can't cascade
 * across the whole benchmark.
 */
async function seedBenchmarkCaseFixtures(
  runtime: AgentRuntime,
  userEntityId: string,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    const { LifeOpsRepository } = await import(
      // @ts-expect-error — workspace package resolved at runtime
      "@elizaos/app-lifeops/lifeops/repository"
    );
    const repo = new LifeOpsRepository(runtime);
    if (
      typeof (repo as unknown as { upsertRelationship?: unknown })
        .upsertRelationship === "function"
    ) {
      await (
        repo as unknown as {
          upsertRelationship: (
            rel: Record<string, unknown>,
          ) => Promise<unknown>;
        }
      ).upsertRelationship({
        id: crypto.randomUUID(),
        agentId: runtime.agentId,
        name: "David",
        primaryChannel: "email",
        primaryHandle: "david@example.com",
        email: "david@example.com",
        phone: null,
        notes: "benchmark fixture",
        tags: ["benchmark"],
        relationshipType: "colleague",
        lastContactedAt: null,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      });
    }
  } catch (error) {
    // Relationships plugin may not be loaded in every benchmark variant.
    runtime.logger?.debug?.(
      { src: "benchmark", userEntityId, error: String(error) },
      "seedBenchmarkCaseFixtures: relationship seed skipped",
    );
  }
}

/**
 * Run a single case against the runtime: register a one-shot hook that
 * captures the first action name delivered for this room, send the message,
 * wait for handling to complete (or timeout), and return the captured action.
 */
async function runSingleCaseWithRecording(
  runtime: AgentRuntime,
  tc: ActionBenchmarkCase,
  timeoutMs: number,
  trajectoryDir: string | undefined,
  registeredActions: string[],
): Promise<ActionBenchmarkResult> {
  const started = Date.now();
  const userEntityId = resolveBenchmarkOwnerEntityId(runtime);
  runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", userEntityId, false);
  await seedBenchmarkCaseFixtures(runtime, userEntityId);
  const harness = new RecordingHarness(runtime, {
    caseId: tc.id,
    userId: userEntityId,
    source: BENCHMARK_SOURCE,
    userName: BENCHMARK_USER_NAME,
    force: true,
  });
  let startedAction: string | null = null;
  let completedAction: string | null = null;
  let responseText: string | undefined;
  try {
    await harness.setup();
    const turn = await harness.send(tc.userMessage, { timeoutMs });
    startedAction = pickObservedAction(
      turn.actions,
      "started",
      tc.expectedAction,
      tc.acceptableActions,
    );
    completedAction = pickObservedAction(
      turn.actions,
      "completed",
      tc.expectedAction,
      tc.acceptableActions,
      { requireSuccessfulCompletion: true },
    );
    responseText =
      typeof turn.responseText === "string"
        ? turn.responseText.slice(0, 200)
        : undefined;
    const trajectory = harness.dumpTrajectory();
    const planner = extractPlannerDecision(trajectory);
    const filteredActions =
      planner.availableActions.length > 0
        ? registeredActions.filter(
            (actionName) => !planner.availableActions.includes(actionName),
          )
        : [];
    const plannerPass = caseMatches(
      planner.plannedAction,
      tc.expectedAction,
      tc.acceptableActions,
    );
    const startedPass = caseMatches(
      startedAction,
      tc.expectedAction,
      tc.acceptableActions,
    );
    const executionPass = caseMatches(
      completedAction,
      tc.expectedAction,
      tc.acceptableActions,
    );
    const selectionPass = plannerPass || startedPass || executionPass;
    const pass = selectionPass;
    const failureMode = determineFailureMode({
      pass,
      expected: tc.expectedAction,
      actual: completedAction,
      planned: planner.plannedAction,
      filtered: filteredActions,
      hadError: false,
    });
    harness.setMetadata("expectedAction", tc.expectedAction);
    harness.setMetadata("plannerPass", plannerPass);
    harness.setMetadata("plannedAction", planner.plannedAction);
    harness.setMetadata("startedAction", startedAction);
    harness.setMetadata("actualAction", completedAction);
    harness.setMetadata("pass", pass);
    harness.setMetadata("selectionPass", selectionPass);
    harness.setMetadata("executionPass", executionPass);
    harness.setMetadata("tags", tc.tags);
    harness.setMetadata("failureMode", failureMode);
    harness.setMetadata("availableActions", planner.availableActions);
    harness.setMetadata("filteredActions", filteredActions);
    let trajectoryPath: string | undefined;
    if (trajectoryDir) {
      trajectoryPath = path.join(trajectoryDir, "cases", `${tc.id}.json`);
      await harness.writeTrajectoryToFile(trajectoryPath);
    }
    return {
      case: tc,
      plannerPass,
      plannedAction: planner.plannedAction,
      plannedActions: planner.plannedActions,
      startedAction,
      completedAction,
      actualAction: completedAction,
      selectionPass,
      executionPass,
      pass,
      latencyMs: Date.now() - started,
      trajectory,
      trajectoryPath,
      failureMode,
      filteredActions,
      availableActions: planner.availableActions,
      registeredActions,
      responseText,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const trajectory = harness.dumpTrajectory();
    const planner = extractPlannerDecision(trajectory);
    const filteredActions =
      planner.availableActions.length > 0
        ? registeredActions.filter(
            (actionName) => !planner.availableActions.includes(actionName),
          )
        : [];
    startedAction ??= pickObservedAction(
      trajectory.actions,
      "started",
      tc.expectedAction,
      tc.acceptableActions,
    );
    completedAction ??= pickObservedAction(
      trajectory.actions,
      "completed",
      tc.expectedAction,
      tc.acceptableActions,
      { requireSuccessfulCompletion: true },
    );
    const plannerPass = caseMatches(
      planner.plannedAction,
      tc.expectedAction,
      tc.acceptableActions,
    );
    const startedPass = caseMatches(
      startedAction,
      tc.expectedAction,
      tc.acceptableActions,
    );
    const executionPass = caseMatches(
      completedAction,
      tc.expectedAction,
      tc.acceptableActions,
    );
    const selectionPass = plannerPass || startedPass || executionPass;
    const failureMode = determineFailureMode({
      pass: selectionPass,
      expected: tc.expectedAction,
      actual: completedAction,
      planned: planner.plannedAction,
      filtered: filteredActions,
      hadError: true,
    });
    harness.setMetadata("expectedAction", tc.expectedAction);
    harness.setMetadata("plannerPass", plannerPass);
    harness.setMetadata("plannedAction", planner.plannedAction);
    harness.setMetadata("startedAction", startedAction);
    harness.setMetadata("actualAction", completedAction);
    harness.setMetadata("pass", selectionPass);
    harness.setMetadata("selectionPass", selectionPass);
    harness.setMetadata("executionPass", executionPass);
    harness.setMetadata("tags", tc.tags);
    harness.setMetadata("failureMode", failureMode);
    harness.setMetadata("availableActions", planner.availableActions);
    harness.setMetadata("filteredActions", filteredActions);
    harness.setMetadata("error", message);
    let trajectoryPath: string | undefined;
    if (trajectoryDir) {
      trajectoryPath = path.join(trajectoryDir, "cases", `${tc.id}.json`);
      await harness.writeTrajectoryToFile(trajectoryPath);
    }
    return {
      case: tc,
      plannerPass,
      plannedAction: planner.plannedAction,
      plannedActions: planner.plannedActions,
      startedAction,
      completedAction,
      actualAction: completedAction,
      selectionPass,
      executionPass,
      pass: selectionPass,
      latencyMs: Date.now() - started,
      error: message,
      trajectory,
      trajectoryPath,
      failureMode,
      filteredActions,
      availableActions: planner.availableActions,
      registeredActions,
      responseText,
    };
  } finally {
    await harness.cleanup();
  }
}

async function runSingleCase(
  runtime: AgentRuntime,
  tc: ActionBenchmarkCase,
  timeoutMs: number,
  registeredActions: string[],
): Promise<ActionBenchmarkResult> {
  const started = Date.now();
  const roomId = crypto.randomUUID() as UUID;
  const entityId = resolveBenchmarkOwnerEntityId(runtime);
  const worldId = crypto.randomUUID() as UUID;

  const capture: TurnCapture = { firstAction: null };
  const hookId = `action-benchmark-${tc.id}-${roomId}`;

  try {
    runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", entityId, false);
    await seedBenchmarkCaseFixtures(runtime, entityId);
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId,
      userName: BENCHMARK_USER_NAME,
      source: BENCHMARK_SOURCE,
      channelId: roomId,
      type: ChannelType.DM,
    });

    runtime.registerPipelineHook({
      id: hookId,
      phase: "outgoing_before_deliver",
      handler: (_runtime, ctx) => {
        if (ctx.phase !== "outgoing_before_deliver") return;
        if (ctx.roomId !== roomId) return;
        if (capture.firstAction !== null) return;
        const name = ctx.actionName;
        if (typeof name === "string" && name.trim().length > 0) {
          capture.firstAction = name;
        }
      },
    });

    const message = createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId,
      roomId,
      content: {
        text: tc.userMessage,
        source: BENCHMARK_SOURCE,
        channelType: ChannelType.DM,
      },
    });

    const filteredActions = await computeFilteredActions(runtime, message);

    const handlePromise = Promise.resolve(
      runtime.messageService?.handleMessage(runtime, message, async () => []),
    );

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`benchmark case ${tc.id} exceeded timeout ${timeoutMs}ms`),
        );
      }, timeoutMs);
      handlePromise
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err as Error);
        });
    });

    const pass = caseMatches(
      capture.firstAction,
      tc.expectedAction,
      tc.acceptableActions,
    );
    const failureMode = determineFailureMode({
      pass,
      expected: tc.expectedAction,
      actual: capture.firstAction,
      planned: capture.firstAction,
      filtered: filteredActions,
      hadError: false,
    });

    return {
      case: tc,
      plannedAction: capture.firstAction,
      plannedActions: capture.firstAction ? [capture.firstAction] : [],
      startedAction: capture.firstAction,
      completedAction: capture.firstAction,
      actualAction: capture.firstAction,
      selectionPass: pass,
      executionPass: pass,
      pass,
      latencyMs: Date.now() - started,
      failureMode,
      filteredActions,
      registeredActions,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      case: tc,
      plannedAction: capture.firstAction,
      plannedActions: capture.firstAction ? [capture.firstAction] : [],
      startedAction: capture.firstAction,
      completedAction: capture.firstAction,
      actualAction: capture.firstAction,
      selectionPass: false,
      executionPass: false,
      pass: false,
      latencyMs: Date.now() - started,
      error: message,
      failureMode: "error",
      registeredActions,
    };
  } finally {
    try {
      runtime.unregisterPipelineHook(hookId);
    } catch {
      // Hook removal is best-effort; benchmark progress must not block on it.
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx] ?? 0;
}

export async function runActionSelectionBenchmark(
  opts: ActionBenchmarkRunOptions,
): Promise<ActionBenchmarkReport> {
  if (!opts.runtime && !opts.createCaseRuntime) {
    throw new Error(
      "runActionSelectionBenchmark requires either a shared runtime or createCaseRuntime",
    );
  }
  const timeoutMs = opts.timeoutMsPerCase ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const captureEnabled =
    opts.forceTrajectoryCapture === true || isTrajectoryCaptureEnabled();
  const trajectoryDir = captureEnabled ? opts.trajectoryDir : undefined;
  if (captureEnabled && trajectoryDir) {
    await fs.rm(trajectoryDir, { recursive: true, force: true });
  }

  const sharedRegisteredActions =
    opts.runtime?.actions.map((a) => a.name) ?? [];

  const runOne = async (
    tc: ActionBenchmarkCase,
  ): Promise<ActionBenchmarkResult> => {
    if (opts.createCaseRuntime) {
      const handle = await opts.createCaseRuntime();
      const registeredActions = handle.runtime.actions.map((a) => a.name);
      try {
        return captureEnabled
          ? await runSingleCaseWithRecording(
              handle.runtime,
              tc,
              timeoutMs,
              trajectoryDir,
              registeredActions,
            )
          : await runSingleCase(
              handle.runtime,
              tc,
              timeoutMs,
              registeredActions,
            );
      } finally {
        await handle.cleanup();
      }
    }

    return captureEnabled
      ? runSingleCaseWithRecording(
          opts.runtime as AgentRuntime,
          tc,
          timeoutMs,
          trajectoryDir,
          sharedRegisteredActions,
        )
      : runSingleCase(
          opts.runtime as AgentRuntime,
          tc,
          timeoutMs,
          sharedRegisteredActions,
        );
  };

  const runOneWithRetries = async (
    tc: ActionBenchmarkCase,
  ): Promise<ActionBenchmarkResult> => {
    for (let attempt = 0; attempt <= RETRYABLE_CASE_ATTEMPTS; attempt += 1) {
      const result = await runOne(tc);
      if (result.pass || !isRetryableCaseError(result.error)) {
        return result;
      }
      if (attempt === RETRYABLE_CASE_ATTEMPTS) {
        return result;
      }
      await sleep(RETRYABLE_CASE_BACKOFF_MS * 2 ** attempt);
    }
    throw new Error(`unreachable retry loop for benchmark case ${tc.id}`);
  };

  const results: ActionBenchmarkResult[] = [];

  if (concurrency === 1) {
    for (const tc of opts.cases) {
      results.push(await runOneWithRetries(tc));
    }
  } else {
    let cursor = 0;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i += 1) {
      workers.push(
        (async () => {
          while (cursor < opts.cases.length) {
            const myIdx = cursor;
            cursor += 1;
            const tc = opts.cases[myIdx];
            if (!tc) break;
            const res = await runOneWithRetries(tc);
            results[myIdx] = res;
          }
        })(),
      );
    }
    await Promise.all(workers);
  }

  if (captureEnabled && trajectoryDir) {
    await writeTrajectoryIndexHtml(trajectoryDir, results);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;

  const byTag: Record<string, ActionBenchmarkTagStats> = {};
  for (const r of results) {
    for (const tag of r.case.tags) {
      const bucket = byTag[tag] ?? { total: 0, passed: 0, accuracy: 0 };
      bucket.total += 1;
      if (r.pass) bucket.passed += 1;
      byTag[tag] = bucket;
    }
  }
  for (const tag of Object.keys(byTag)) {
    const b = byTag[tag];
    if (!b) continue;
    b.accuracy = b.total === 0 ? 0 : b.passed / b.total;
  }

  const latencies = [...results.map((r) => r.latencyMs)].sort((a, b) => a - b);
  const avg =
    latencies.length === 0
      ? 0
      : latencies.reduce((sum, v) => sum + v, 0) / latencies.length;

  return {
    total: results.length,
    passed,
    failed,
    accuracy: results.length === 0 ? 0 : passed / results.length,
    byTag,
    latency: {
      avg,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
    },
    failures: results.filter((r) => !r.pass),
    results,
  };
}

async function writeTrajectoryIndexHtml(
  trajectoryDir: string,
  results: ActionBenchmarkResult[],
): Promise<void> {
  const indexPath = path.join(trajectoryDir, "index.html");
  await fs.mkdir(trajectoryDir, { recursive: true });
  const rows = results
    .map((r) => {
      const status = r.pass ? "PASS" : "FAIL";
      const expected = r.case.expectedAction ?? "(none)";
      const planned = r.plannedAction ?? "(none)";
      const completed = r.completedAction ?? "(none)";
      const link = `cases/${r.case.id}.json`;
      const colour = r.pass ? "#0a7" : "#c33";
      return `<tr>
  <td><a href="${link}">${escapeHtml(r.case.id)}</a></td>
  <td style="color:${colour};font-weight:600">${status}</td>
  <td>${escapeHtml(expected)}</td>
  <td>${escapeHtml(planned)}</td>
  <td>${escapeHtml(completed)}</td>
  <td>${Math.round(r.latencyMs)}ms</td>
  <td>${escapeHtml(r.case.tags.join(", "))}</td>
</tr>`;
    })
    .join("\n");
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Action Benchmark Trajectories</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 6px 12px; border-bottom: 1px solid #eee; text-align: left; }
  th { background: #f5f5f7; }
</style></head><body>
<h1>Action Benchmark Trajectories</h1>
<p>${results.filter((r) => r.pass).length} / ${results.length} passed.</p>
<table>
<thead><tr><th>Case</th><th>Result</th><th>Expected</th><th>Planned</th><th>Completed</th><th>Latency</th><th>Tags</th></tr></thead>
<tbody>
${rows}
</tbody></table>
</body></html>`;
  await fs.writeFile(indexPath, html, "utf8");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatBenchmarkReportMarkdown(
  report: ActionBenchmarkReport,
): string {
  const lines: string[] = [];
  const selectionPassed = report.results.filter((result) => result.pass).length;
  const plannerPassed = report.results.filter(
    (result) => result.plannerPass,
  ).length;
  const executionPassed = report.results.filter(
    (result) => result.executionPass,
  ).length;
  const executionIssues = report.results.filter(
    (result) => result.pass && (!result.executionPass || Boolean(result.error)),
  );
  lines.push("# Action Selection Benchmark");
  lines.push("");
  lines.push(
    `**Selection Accuracy:** ${(report.accuracy * 100).toFixed(1)}% (${selectionPassed}/${report.total})`,
  );
  lines.push(
    `**Latency:** avg ${Math.round(report.latency.avg)}ms · p50 ${Math.round(
      report.latency.p50,
    )}ms · p95 ${Math.round(report.latency.p95)}ms`,
  );
  lines.push(
    `**Planner Accuracy:** ${(report.total === 0 ? 0 : (plannerPassed / report.total) * 100).toFixed(1)}% (${plannerPassed}/${report.total})`,
  );
  lines.push(
    `**Execution Accuracy:** ${(report.total === 0 ? 0 : (executionPassed / report.total) * 100).toFixed(1)}% (${executionPassed}/${report.total})`,
  );
  lines.push("");

  lines.push("## By tag");
  lines.push("");
  lines.push("| Tag | Passed | Total | Accuracy |");
  lines.push("| --- | ---: | ---: | ---: |");
  const tagEntries = Object.entries(report.byTag).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [tag, stats] of tagEntries) {
    lines.push(
      `| ${tag} | ${stats.passed} | ${stats.total} | ${(stats.accuracy * 100).toFixed(1)}% |`,
    );
  }
  lines.push("");

  const modeCounts: Record<ActionFailureMode, number> = {
    passed: 0,
    validate_filtered: 0,
    llm_chose_reply: 0,
    llm_chose_other_action: 0,
    no_response: 0,
    error: 0,
  };
  for (const r of report.results) {
    const mode: ActionFailureMode =
      r.failureMode ?? (r.pass ? "passed" : "error");
    modeCounts[mode] += 1;
  }

  lines.push("## By failure mode");
  lines.push("");
  lines.push("| Mode | Count |");
  lines.push("| --- | ---: |");
  for (const mode of [
    "passed",
    "validate_filtered",
    "llm_chose_reply",
    "llm_chose_other_action",
    "no_response",
    "error",
  ] as ActionFailureMode[]) {
    lines.push(`| ${mode} | ${modeCounts[mode]} |`);
  }
  lines.push("");

  if (report.failures.length > 0) {
    lines.push(`## Failures (${report.failures.length})`);
    lines.push("");
    lines.push(
      "| Case | Expected | Planned | Completed | Failure Mode | Error |",
    );
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const f of report.failures) {
      const expected =
        f.case.expectedAction === null ? "(no action)" : f.case.expectedAction;
      const planned = f.plannedAction ?? "(none)";
      const completed = f.completedAction ?? "(none)";
      const mode = f.failureMode ?? "error";
      const err = f.error ? f.error.replace(/\|/g, "\\|") : "";
      lines.push(
        `| ${f.case.id} | ${expected} | ${planned} | ${completed} | ${mode} | ${err} |`,
      );
    }
    lines.push("");
  }

  if (executionIssues.length > 0) {
    lines.push(`## Execution Issues (${executionIssues.length})`);
    lines.push("");
    lines.push("| Case | Planned | Started | Completed | Error |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const result of executionIssues) {
      lines.push(
        `| ${result.case.id} | ${result.plannedAction ?? "(none)"} | ${result.startedAction ?? "(none)"} | ${result.completedAction ?? "(none)"} | ${(result.error ?? "").replace(/\|/g, "\\|")} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
