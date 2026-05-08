/**
 * Action selection benchmark runner.
 *
 * Given a real `AgentRuntime` and a list of `ActionBenchmarkCase`s, send each
 * user message through the runtime, capture the actions the agent actually
 * starts/completes via the shared ActionSpy / ConversationHarness path, score
 * each case, and produce a report.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type AgentRuntime,
  ChannelType,
  type Memory,
  parseJSONObjectFromText,
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
  /** Populated when trajectory capture is enabled (ELIZA_DUMP_TRAJECTORIES=1). */
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
  /** When runsPerCase > 1, the 1-based run index this result came from. */
  runIndex?: number;
  /** When runsPerCase > 1, total runs scheduled for this case. */
  runsPerCase?: number;
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

export interface ActionBenchmarkCacheStats {
  llmCalls: number;
  llmCallsWithUsage: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputRatio: number;
  cacheCreationInputRatio: number;
}

export interface CaseReliability {
  caseId: string;
  expectedAction: string | null;
  runs: number;
  passes: number;
  passRate: number;
  /** Per-run actual action (null if no action picked or run errored). */
  actuals: Array<string | null>;
}

export interface ActionBenchmarkReport {
  total: number;
  passed: number;
  failed: number;
  accuracy: number;
  byTag: Record<string, ActionBenchmarkTagStats>;
  latency: ActionBenchmarkLatencyStats;
  cache?: ActionBenchmarkCacheStats;
  /** Per-case reliability when runsPerCase > 1. */
  reliability?: CaseReliability[];
  /** Number of independent runs scheduled per case. */
  runsPerCase?: number;
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
   * trajectory capture is enabled (`ELIZA_DUMP_TRAJECTORIES=1` or the
   * `forceTrajectoryCapture` flag).
   */
  trajectoryDir?: string;
  /** Force trajectory capture even when the env flag is not set. */
  forceTrajectoryCapture?: boolean;
  /**
   * Number of independent runs per case. Defaults to 1. When > 1, the
   * report includes a reliability table bucketed by pass-rate (0/N, 1/N,
   * 2/N, …, N/N) so deterministic-broken cases are distinguished from
   * stochastic flakes. Override via `ELIZA_BENCHMARK_RUNS_PER_CASE`.
   */
  runsPerCase?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const BENCHMARK_SOURCE = "dashboard";
const BENCHMARK_USER_NAME = "Owner";
const RETRYABLE_CASE_ATTEMPTS = 3;
const RETRYABLE_CASE_BACKOFF_MS = 5_000;
const GENERIC_ACTION_NAMES = new Set(["REPLY", "IGNORE", "NONE"]);
const NON_SELECTION_ACTION_NAMES = new Set([
  "RELATIONSHIP_EXTRACTION",
  "FACT_EXTRACTOR",
  "REFLECTION",
]);
const ACTION_CANONICAL_NAMES = new Map<string, string>([
  ["GOOGLE_CALENDAR", "CALENDAR"],
  ["CALENDLY", "CALENDAR"],
  ["SCHEDULING", "CALENDAR"],
  ["PROPOSE_MEETING_TIMES", "CALENDAR"],
  ["CHECK_AVAILABILITY", "CALENDAR"],
  ["UPDATE_MEETING_PREFERENCES", "CALENDAR"],
  ["CALENDAR_READ", "CALENDAR"],
  ["CALENDAR_CREATE_EVENT", "CALENDAR"],
  ["CALENDAR_FEED", "CALENDAR"],
  ["ADD_TODO", "LIFE"],
  ["CREATE_TODO", "LIFE"],
  ["LIST_TODOS", "LIFE"],
  ["GET_TODOS", "LIFE"],
  ["LIFE_GET_TODOS", "LIFE"],
  ["LIFE_TODO", "LIFE"],
  ["ADD_HABIT", "LIFE"],
  ["CREATE_HABIT", "LIFE"],
  ["LIST_HABITS", "LIFE"],
  ["ADD_GOAL", "LIFE"],
  ["CREATE_GOAL", "LIFE"],
  ["CREATE_REMINDER", "LIFE"],
  ["SET_REMINDER_RULE", "LIFE"],
  ["MESSAGE", "MESSAGE"],
  ["DISPATCH_DRAFT", "MESSAGE"],
  ["CONFIRM_AND_SEND", "MESSAGE"],
  ["SOCIAL_POSTING", "POST"],
  ["GET_TIMELINE", "POST"],
  ["READ_TIMELINE", "POST"],
  ["BLOCK_WEBSITE", "WEBSITE_BLOCK"],
  ["WEBSITE_BLOCKER", "WEBSITE_BLOCK"],
  ["SET_APP_BLOCK", "APP_BLOCK"],
  ["PHONE_SET_APP_BLOCK", "APP_BLOCK"],
  ["PHONE_BLOCK_APPS", "APP_BLOCK"],
  ["BLOCK_APPS", "APP_BLOCK"],
  ["BROADCAST_INTENT", "DEVICE_INTENT"],
  ["BROADCAST_REMINDER", "DEVICE_INTENT"],
  ["DEVICE_BROADCAST", "DEVICE_INTENT"],
  ["MOBILE_REMINDER", "DEVICE_INTENT"],
  ["INTENT_SYNC", "DEVICE_INTENT"],
  ["FILE_ACTION", "COMPUTER_USE"],
  ["TERMINAL_ACTION", "COMPUTER_USE"],
  ["BROWSER_ACTION", "COMPUTER_USE"],
  ["MANAGE_WINDOW", "COMPUTER_USE"],
]);

function resolveBenchmarkOwnerEntityId(runtime: AgentRuntime): UUID {
  const configured = runtime.getSetting("ELIZA_ADMIN_ENTITY_ID");
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured as UUID;
  }
  return stringToUuid(`${runtime.agentId}-admin-entity`);
}

async function _ensureBenchmarkConversation(args: {
  runtime: AgentRuntime;
  entityId: UUID;
  roomId: UUID;
  worldId: UUID;
}): Promise<void> {
  const { runtime, entityId, roomId, worldId } = args;
  const worldMetadata = {
    ownership: {
      ownerId: entityId,
    },
    roles: {
      [entityId]: "OWNER",
    },
  } as const;

  await runtime.ensureWorldExists({
    id: worldId,
    name: `${BENCHMARK_USER_NAME}'s Benchmark World`,
    agentId: runtime.agentId,
    messageServerId: entityId,
    metadata: worldMetadata,
  });

  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    worldName: `${BENCHMARK_USER_NAME}'s Benchmark World`,
    userName: BENCHMARK_USER_NAME,
    name: BENCHMARK_USER_NAME,
    source: BENCHMARK_SOURCE,
    channelId: roomId,
    type: ChannelType.DM,
    messageServerId: entityId,
    metadata: worldMetadata,
  });

  await runtime.ensureParticipantInRoom(runtime.agentId, roomId);
  await runtime.ensureParticipantInRoom(entityId, roomId);
}

export function normalizeActionName(
  name: string | null | undefined,
): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const normalized = trimmed
    .toUpperCase()
    .replace(/^FUNCTIONS\./, "")
    .replace(/[\s-]+/g, "_");
  const compoundMatch = normalized.match(/^([A-Z0-9_]+)\.[A-Z0-9_]+$/);
  if (compoundMatch?.[1]) {
    return ACTION_CANONICAL_NAMES.get(compoundMatch[1]) ?? compoundMatch[1];
  }
  return ACTION_CANONICAL_NAMES.get(normalized) ?? normalized;
}

function canonicalActionName(name: string | null | undefined): string | null {
  const normalized = normalizeActionName(name);
  if (normalized === null) return null;
  return ACTION_CANONICAL_NAMES.get(normalized) ?? normalized;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableCaseError(error: string | undefined): boolean {
  if (!error) return false;
  // Rate limits and explicit "try again" hints.
  if (
    /rate limit|too many requests|tokens per minute|please try again in/i.test(
      error,
    )
  ) {
    return true;
  }
  // Harness-layer timeouts are almost always rate-limit-induced in the
  // benchmark (the real cause was an upstream 429 that consumed the whole
  // 90s budget through internal SDK retries). Treat them as retryable too —
  // the retry gives the TPM window time to drain before the next attempt.
  if (/timed out after/i.test(error)) return true;
  return false;
}

/**
 * Inter-case pause to prevent the benchmark from saturating TPM limits on
 * throughput-constrained providers (e.g. GROQ llama-3.1-8b-instant has a
 * 250k TPM ceiling that a 69-case run will otherwise wipe out). Override
 * with `ELIZA_BENCHMARK_CASE_PAUSE_MS`. Default is off for local non-TPM
 * providers; opt-in for rate-limited providers.
 */
function caseThrottleMs(): number {
  const raw =
    typeof process !== "undefined"
      ? process.env.ELIZA_BENCHMARK_CASE_PAUSE_MS
      : undefined;
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function caseMatches(
  actual: string | null,
  expected: string | null,
  acceptable: string[] | undefined,
): boolean {
  const actualNorm = canonicalActionName(actual);
  if (expected === null) {
    return (
      actualNorm === null ||
      (actualNorm !== null && GENERIC_ACTION_NAMES.has(actualNorm))
    );
  }
  const expectedNorm = canonicalActionName(expected);
  if (actualNorm !== null && actualNorm === expectedNorm) return true;
  if (!acceptable) return false;
  for (const alt of acceptable) {
    if (actualNorm !== null && canonicalActionName(alt) === actualNorm) {
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
  const normalized = canonicalActionName(name);
  return normalized !== null && GENERIC_ACTION_NAMES.has(normalized);
}

function isNonSelectionActionName(name: string | null | undefined): boolean {
  const normalized = canonicalActionName(name);
  return normalized !== null && NON_SELECTION_ACTION_NAMES.has(normalized);
}

export function pickObservedAction(
  records: ReadonlyArray<{
    phase: "started" | "completed";
    actionName: string;
    actionStatus?: string;
    actionConfirmationPending?: boolean;
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
        record.actionStatus !== "completed" &&
        // Actions whose intended terminal state is "user must confirm" return
        // success: false (so actionStatus is "failed"), but selection +
        // execution were both correct. Score them as completed.
        record.actionConfirmationPending !== true
      ) {
        return false;
      }
      return true;
    })
    .map((record) => record.actionName)
    .filter(
      (name) =>
        typeof name === "string" &&
        name.trim().length > 0 &&
        !isNonSelectionActionName(name),
    );
  return (
    firstMatchingActionName(names, expected, acceptable) ??
    names.find(
      (name) => !isGenericActionName(name) && !isNonSelectionActionName(name),
    ) ??
    null
  );
}

function computeFilteredActions(
  registeredActions: string[],
  availableActions: string[],
): string[] {
  const availableCanonical = new Set(
    availableActions
      .map((actionName) => canonicalActionName(actionName))
      .filter((actionName): actionName is string => actionName !== null),
  );
  return registeredActions.filter((actionName) => {
    const canonical = canonicalActionName(actionName);
    return canonical === null || !availableCanonical.has(canonical);
  });
}

/**
 * After the runtime has handled a message, ask each registered action's
 * `validate()` whether it would have accepted that message. Returns the names
 * of actions that returned false (i.e. were filtered out before the LLM saw
 * them). This is what distinguishes "action exists but was hidden" from "LLM
 * picked wrong action".
 */
async function _computeFilteredActions(
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

export function determineFailureMode(args: {
  pass: boolean;
  expected: string | null;
  actual: string | null;
  planned: string | null;
  filtered: string[];
  hadError: boolean;
}): ActionFailureMode {
  if (args.pass) return "passed";
  if (args.hadError) return "error";
  const actualNorm = canonicalActionName(args.actual);
  const plannedNorm = canonicalActionName(args.planned);
  const expectedNorm = canonicalActionName(args.expected);
  if (
    actualNorm !== null &&
    expectedNorm !== null &&
    actualNorm === expectedNorm
  ) {
    return "passed";
  }
  if (
    expectedNorm !== null &&
    args.filtered.some((n) => canonicalActionName(n) === expectedNorm)
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
      args.filtered.some((n) => canonicalActionName(n) === expectedNorm)
    ) {
      return "validate_filtered";
    }
    return "llm_chose_reply";
  }
  return "llm_chose_other_action";
}

function finiteToken(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function summarizeCacheStats(
  results: readonly ActionBenchmarkResult[],
): ActionBenchmarkCacheStats | undefined {
  let llmCalls = 0;
  let llmCallsWithUsage = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;

  for (const result of results) {
    for (const call of result.trajectory?.agentTrajectory.llmCalls ?? []) {
      llmCalls += 1;
      const callPromptTokens = finiteToken(call.promptTokens);
      const callCompletionTokens = finiteToken(call.completionTokens);
      const callTotalTokens = finiteToken(call.totalTokens);
      const callCacheReadInputTokens = finiteToken(call.cacheReadInputTokens);
      const callCacheCreationInputTokens = finiteToken(
        call.cacheCreationInputTokens,
      );
      if (
        callPromptTokens > 0 ||
        callCompletionTokens > 0 ||
        callTotalTokens > 0 ||
        callCacheReadInputTokens > 0 ||
        callCacheCreationInputTokens > 0
      ) {
        llmCallsWithUsage += 1;
      }
      promptTokens += callPromptTokens;
      completionTokens += callCompletionTokens;
      totalTokens +=
        callTotalTokens > 0
          ? callTotalTokens
          : callPromptTokens + callCompletionTokens;
      cacheReadInputTokens += callCacheReadInputTokens;
      cacheCreationInputTokens += callCacheCreationInputTokens;
    }
  }

  if (llmCalls === 0) return undefined;
  return {
    llmCalls,
    llmCallsWithUsage,
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheReadInputRatio:
      promptTokens === 0 ? 0 : cacheReadInputTokens / promptTokens,
    cacheCreationInputRatio:
      promptTokens === 0 ? 0 : cacheCreationInputTokens / promptTokens,
  };
}

interface PlannerDecision {
  availableActions: string[];
  plannedActions: string[];
  plannedAction: string | null;
}

function parseAvailableActionsFromPrompt(prompt: string): string[] {
  try {
    const parsed = JSON.parse(prompt) as { tools?: unknown };
    if (Array.isArray(parsed.tools)) {
      return parsed.tools
        .flatMap((tool) => {
          if (!tool || typeof tool !== "object") return [];
          const record = tool as Record<string, unknown>;
          const fn = record.function as Record<string, unknown> | undefined;
          const name = record.name ?? record.toolName ?? fn?.name;
          return typeof name === "string" ? [name] : [];
        })
        .map((name) => normalizeActionName(name))
        .filter((name): name is string => name !== null);
    }
  } catch {
    // Fall back to parsing the legacy markdown prompt below.
  }

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

function parseRecordValue(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isPlannerWrapperAction(name: string | null): boolean {
  return name === "CALL_ACTION" || name === "PLAN_ACTIONS";
}

function isPlannerProtocolAction(name: string | null): boolean {
  const canonical = canonicalActionName(name);
  return canonical === "HANDLE_RESPONSE" || isPlannerWrapperAction(canonical);
}

export function parsePlannedActionsFromResponse(response: string): string[] {
  const parsed = parseJSONObjectFromText(response);
  if (!parsed) {
    return [];
  }
  const rawActions =
    parsed.toolCalls ??
    parsed.tool_calls ??
    parsed.actions ??
    parsed.action ??
    parsed.name ??
    parsed.actionName;
  const actionValues = Array.isArray(rawActions) ? rawActions : [rawActions];
  const names = actionValues
    .flatMap((action) => {
      if (typeof action === "string") {
        return action.split(",");
      }
      if (action && typeof action === "object") {
        const record = action as Record<string, unknown>;
        const rawFunction = parseRecordValue(record.function);
        const input =
          parseRecordValue(record.input) ??
          parseRecordValue(record.arguments) ??
          parseRecordValue(rawFunction?.arguments);
        const rawName =
          record.name ??
          record.action ??
          record.actionName ??
          record.toolName ??
          rawFunction?.name;
        const canonicalRawName =
          typeof rawName === "string" ? canonicalActionName(rawName) : null;
        if (isPlannerWrapperAction(canonicalRawName)) {
          const actionParameters = parseRecordValue(record.actionParameters);
          const nestedName =
            input?.action ??
            input?.actionName ??
            input?.name ??
            actionParameters?.action ??
            actionParameters?.actionName;
          return typeof nestedName === "string" ? [nestedName] : [];
        }
        return typeof rawName === "string" ? [rawName] : [];
      }
      return [];
    })
    .map((name) => canonicalActionName(name))
    .filter(
      (name): name is string => name !== null && !isPlannerProtocolAction(name),
    );
  return [...new Set(names)];
}

function extractPlannerDecision(
  trajectory: TrajectoryRecord | undefined,
  registeredActions: readonly string[] = [],
): PlannerDecision {
  const plannerCalls =
    trajectory?.agentTrajectory.llmCalls.filter(
      (call) => call.purpose === "action_planner",
    ) ?? [];
  if (plannerCalls.length === 0) {
    return {
      availableActions: [],
      plannedActions: [],
      plannedAction: null,
    };
  }
  let fallback: PlannerDecision | null = null;
  for (const plannerCall of plannerCalls) {
    const rawAvailableActions = parseAvailableActionsFromPrompt(
      plannerCall.prompt,
    );
    const visibleActionsAreWrappers =
      rawAvailableActions.length > 0 &&
      rawAvailableActions.every((name) =>
        isPlannerProtocolAction(canonicalActionName(name)),
      );
    const availableActions =
      visibleActionsAreWrappers && registeredActions.length > 0
        ? registeredActions
            .map((name) => normalizeActionName(name))
            .filter((name): name is string => name !== null)
        : rawAvailableActions;
    const plannedActions = parsePlannedActionsFromResponse(
      plannerCall.response,
    );
    const decision = {
      availableActions,
      plannedActions,
      plannedAction: plannedActions[0] ?? null,
    };
    fallback ??= decision;
    if (plannedActions.length > 0) {
      return decision;
    }
  }
  return (
    fallback ?? {
      availableActions: [],
      plannedActions: [],
      plannedAction: null,
    }
  );
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
  tc: ActionBenchmarkCase,
): Promise<void> {
  // 1) Ensure the LifeOps plugin schema (incl. life_scheduling_negotiations,
  //    life_scheduling_proposals, life_connector_grants, life_relationships)
  //    is migrated against the per-case PGLite adapter. Idempotent — safe to
  //    call even when the runtime already ran plugin migrations at boot.
  try {
    const { LifeOpsRepository } = (await import(
      // @ts-expect-error — workspace package resolved at runtime
      "@elizaos/app-lifeops/lifeops/repository"
    )) as {
      LifeOpsRepository: {
        bootstrapSchema?: (r: AgentRuntime) => Promise<void>;
      };
    };
    if (typeof LifeOpsRepository.bootstrapSchema === "function") {
      await LifeOpsRepository.bootstrapSchema(runtime);
    }
  } catch (error) {
    runtime.logger?.debug?.(
      { src: "benchmark", userEntityId, error: String(error) },
      "seedBenchmarkCaseFixtures: lifeops schema bootstrap skipped",
    );
  }

  // 2) Seed a David relationship row used by relationship-flow benchmark cases.
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
      const upsert = (
        repo as unknown as {
          upsertRelationship: (
            rel: Record<string, unknown>,
          ) => Promise<unknown>;
        }
      ).upsertRelationship.bind(repo);

      // Generic personal contact (used by rel-* and follow-up cases).
      await upsert({
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

      // Counterparty fixtures referenced by scheduling cases. Without
      // these, CALENDAR(negotiate_start) fails downstream with
      // SCHEDULING_NO_COUNTERPARTY_CONTACT because the design-team /
      // Marco / engineering-discord references can't resolve to a known
      // relationship row.
      const counterparties = [
        {
          name: "design team",
          primaryChannel: "email" as const,
          primaryHandle: "design@example.com",
          email: "design@example.com",
          relationshipType: "team",
        },
        {
          name: "Marco",
          primaryChannel: "email" as const,
          primaryHandle: "marco@example.com",
          email: "marco@example.com",
          relationshipType: "colleague",
        },
        {
          name: "Sarah",
          primaryChannel: "email" as const,
          primaryHandle: "sarah@example.com",
          email: "sarah@example.com",
          relationshipType: "colleague",
        },
      ];
      for (const cp of counterparties) {
        await upsert({
          id: crypto.randomUUID(),
          agentId: runtime.agentId,
          name: cp.name,
          primaryChannel: cp.primaryChannel,
          primaryHandle: cp.primaryHandle,
          email: cp.email,
          phone: null,
          notes: "benchmark fixture",
          tags: ["benchmark", "counterparty"],
          relationshipType: cp.relationshipType,
          lastContactedAt: null,
          metadata: {},
          createdAt: now,
          updatedAt: now,
        });
      }

      const relationshipsService = runtime.getService("relationships") as
        | {
            addContact?: (
              entityId: UUID,
              categories?: string[],
              preferences?: Record<string, string>,
              customFields?: Record<string, string>,
            ) => Promise<unknown>;
          }
        | undefined;
      if (typeof relationshipsService?.addContact === "function") {
        for (const contact of [
          { name: "David", email: "david@example.com", category: "colleague" },
          { name: "Marco", email: "marco@example.com", category: "colleague" },
          { name: "Sarah", email: "sarah@example.com", category: "colleague" },
          {
            name: "design team",
            email: "design@example.com",
            category: "team",
          },
        ]) {
          const entityId = stringToUuid(
            `benchmark-contact-${contact.name}-${runtime.agentId}`,
          );
          const existing = await runtime.getEntityById(entityId);
          if (!existing) {
            await runtime.createEntity({
              id: entityId,
              names: [contact.name],
              agentId: runtime.agentId,
              metadata: { email: contact.email, benchmark: true },
            });
          }
          await relationshipsService.addContact(
            entityId,
            [contact.category],
            { email: contact.email },
            { displayName: contact.name, email: contact.email },
          );
        }
      }
    }
    runtime.logger?.debug?.(
      { src: "benchmark", userEntityId },
      "seedBenchmarkCaseFixtures: relationship seeded",
    );
  } catch (error) {
    // Relationships plugin may not be loaded in every benchmark variant.
    runtime.logger?.debug?.(
      { src: "benchmark", userEntityId, error: String(error) },
      "seedBenchmarkCaseFixtures: relationship seed skipped",
    );
  }

  // 3) Seed a Google OAuth connector grant + token file so calendar/inbox
  //    cases can reach the mock Google server. The mock's
  //    `refreshGoogleTokensFromSeededGrants` reads plain-JSON files under
  //    `${ELIZA_STATE_DIR}/credentials/lifeops/google/...` and indexes them
  //    by `accessToken`. The lifeops handler reads the same file via
  //    `readStoredGoogleTokenFile`, which transparently supports legacy
  //    plaintext tokens, so a single plain-JSON write satisfies both sides.
  try {
    const seedModule = (await import(
      // @ts-expect-error — path resolved at runtime relative to repo root
      "../../../../test/mocks/helpers/seed-grants.ts"
    )) as {
      seedGoogleConnectorGrant: (
        runtime: AgentRuntime,
        opts?: {
          capabilities?: string[];
          email?: string;
          grantId?: string;
          side?: "owner" | "agent";
        },
      ) => Promise<void>;
    };
    await seedModule.seedGoogleConnectorGrant(runtime, {
      grantId: `bench-google-${runtime.agentId}`,
      capabilities: [
        "google.calendar.read",
        "google.calendar.write",
        "google.gmail.triage",
        "google.gmail.send",
        "google.gmail.manage",
      ],
      email: "owner@example.test",
    });
    runtime.logger?.debug?.(
      { src: "benchmark", userEntityId, agentId: runtime.agentId },
      "seedBenchmarkCaseFixtures: google connector grant seeded",
    );
  } catch (error) {
    // Mock seed helper not on disk in non-mocked benchmark runs, or lifeops
    // package not available. Either way: not fatal — only the calendar/inbox
    // cases will be affected.
    runtime.logger?.debug?.(
      { src: "benchmark", userEntityId, error: String(error) },
      "seedBenchmarkCaseFixtures: google grant seed skipped",
    );
  }

  // 4) Seed an X (Twitter) connector grant + minimal env credentials so
  //    X_READ's `validate()` resolves to true. Local-mode capability resolution
  //    requires both a grant row and OAuth env credentials before
  //    `feedRead`/`dmRead` are reported as available.
  try {
    process.env.TWITTER_API_KEY = process.env.TWITTER_API_KEY ?? "bench-x-key";
    process.env.TWITTER_API_SECRET_KEY =
      process.env.TWITTER_API_SECRET_KEY ?? "bench-x-secret";
    process.env.TWITTER_ACCESS_TOKEN =
      process.env.TWITTER_ACCESS_TOKEN ?? "bench-x-token";
    process.env.TWITTER_ACCESS_TOKEN_SECRET =
      process.env.TWITTER_ACCESS_TOKEN_SECRET ?? "bench-x-token-secret";
    process.env.TWITTER_USER_ID =
      process.env.TWITTER_USER_ID ?? "bench-x-user-id";

    const seedModule = (await import(
      // @ts-expect-error — path resolved at runtime relative to repo root
      "../../../../test/mocks/helpers/seed-grants.ts"
    )) as {
      seedXConnectorGrant: (
        runtime: AgentRuntime,
        opts?: { side?: "owner" | "agent"; handle?: string },
      ) => Promise<void>;
    };
    await seedModule.seedXConnectorGrant(runtime, { side: "owner" });
    runtime.logger?.debug?.(
      { src: "benchmark", userEntityId, agentId: runtime.agentId },
      "seedBenchmarkCaseFixtures: x connector grant seeded",
    );
  } catch (error) {
    runtime.logger?.debug?.(
      { src: "benchmark", userEntityId, error: String(error) },
      "seedBenchmarkCaseFixtures: x grant seed skipped",
    );
  }

  // 5) Approval benchmark cases say there is a pending travel request. Seed
  //    one so the handler can resolve the user instruction end-to-end instead
  //    of asking for an id the fixture never created.
  if (tc.tags.includes("approval")) {
    let seeded = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 20 && !seeded; attempt += 1) {
      try {
        const approvalModule = await import(
          // @ts-expect-error — workspace package resolved at runtime
          "@elizaos/app-lifeops/lifeops/approval-queue"
        );
        const createApprovalQueue =
          (approvalModule as { createApprovalQueue?: unknown })
            .createApprovalQueue ??
          (
            approvalModule as {
              default?: { createApprovalQueue?: unknown };
            }
          ).default?.createApprovalQueue;
        const createQueue =
          typeof createApprovalQueue === "function"
            ? createApprovalQueue
            : null;
        const fallbackModule =
          createQueue === null
            ? await import(
                // @ts-expect-error — path resolved at runtime relative to this file
                "../../../../plugins/app-lifeops/src/lifeops/approval-queue.ts"
              )
            : null;
        const createApprovalQueueFinal =
          createQueue ??
          (fallbackModule as { createApprovalQueue?: unknown })
            ?.createApprovalQueue;
        if (typeof createApprovalQueueFinal !== "function") {
          throw new TypeError("createApprovalQueue export is unavailable");
        }
        const queue = createApprovalQueueFinal(runtime, {
          agentId: runtime.agentId,
        });
        const existing = await queue.list({
          subjectUserId: userEntityId,
          state: "pending",
          action: "execute_workflow",
          limit: 1,
        });
        if (existing.length === 0) {
          await queue.enqueue({
            requestedBy: "benchmark:action-selection",
            subjectUserId: userEntityId,
            action: "execute_workflow",
            payload: {
              action: "execute_workflow",
              workflowId: "bench-travel-booking-approval",
              input: {
                kind: "travel_booking",
                summary: "San Francisco to New York travel booking",
                itineraryRef: "bench-travel-approval",
                estimatedTotalCents: 49900,
                currency: "USD",
              },
            },
            channel: "internal",
            reason:
              "Pending travel booking request for benchmark approval flow.",
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          });
        }
        const pending = await queue.list({
          subjectUserId: userEntityId,
          state: "pending",
          action: null,
          limit: 1,
        });
        seeded = pending.length > 0;
      } catch (error) {
        lastError = error;
        await sleep(250);
      }
    }
    if (seeded) {
      runtime.logger?.debug?.(
        { src: "benchmark", userEntityId, agentId: runtime.agentId },
        "seedBenchmarkCaseFixtures: approval request seeded",
      );
    } else {
      runtime.logger?.warn?.(
        { src: "benchmark", userEntityId, error: String(lastError) },
        "seedBenchmarkCaseFixtures: approval request seed skipped",
      );
    }
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
  await seedBenchmarkCaseFixtures(runtime, userEntityId, tc);
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
    const planner = extractPlannerDecision(trajectory, registeredActions);
    const filteredActions =
      planner.availableActions.length > 0
        ? computeFilteredActions(registeredActions, planner.availableActions)
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
    const planner = extractPlannerDecision(trajectory, registeredActions);
    const filteredActions =
      planner.availableActions.length > 0
        ? computeFilteredActions(registeredActions, planner.availableActions)
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
    const plannerPass =
      tc.expectedAction === null
        ? false
        : caseMatches(
            planner.plannedAction,
            tc.expectedAction,
            tc.acceptableActions,
          );
    const startedPass =
      tc.expectedAction === null
        ? false
        : caseMatches(startedAction, tc.expectedAction, tc.acceptableActions);
    const executionPass =
      tc.expectedAction === null
        ? false
        : caseMatches(completedAction, tc.expectedAction, tc.acceptableActions);
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

  const runsPerCaseEnv = (() => {
    const raw =
      typeof process !== "undefined"
        ? process.env.ELIZA_BENCHMARK_RUNS_PER_CASE
        : undefined;
    if (!raw) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  })();
  const runsPerCase = Math.max(1, opts.runsPerCase ?? runsPerCaseEnv ?? 1);

  const sharedRegisteredActions =
    opts.runtime?.actions.map((a) => a.name) ?? [];

  const runOne = async (
    tc: ActionBenchmarkCase,
  ): Promise<ActionBenchmarkResult> => {
    if (opts.createCaseRuntime) {
      const handle = await opts.createCaseRuntime();
      const registeredActions = handle.runtime.actions.map((a) => a.name);
      try {
        return await runSingleCaseWithRecording(
          handle.runtime,
          tc,
          timeoutMs,
          captureEnabled ? trajectoryDir : undefined,
          registeredActions,
        );
      } finally {
        await handle.cleanup();
      }
    }

    return runSingleCaseWithRecording(
      opts.runtime as AgentRuntime,
      tc,
      timeoutMs,
      captureEnabled ? trajectoryDir : undefined,
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
  const throttleMs = caseThrottleMs();

  // Expand cases by runsPerCase so each repetition gets its own trajectory
  // file and result row. We clone the case with a suffixed id when N > 1
  // so the recording harness writes to per-run paths without clobbering.
  type ScheduledCase = {
    case: ActionBenchmarkCase;
    runIndex: number;
    originalId: string;
  };
  const scheduled: ScheduledCase[] = [];
  for (const tc of opts.cases) {
    if (runsPerCase === 1) {
      scheduled.push({ case: tc, runIndex: 1, originalId: tc.id });
      continue;
    }
    for (let i = 1; i <= runsPerCase; i += 1) {
      scheduled.push({
        case: { ...tc, id: `${tc.id}#run${i}` },
        runIndex: i,
        originalId: tc.id,
      });
    }
  }

  const stampReliability = (
    item: ScheduledCase,
    result: ActionBenchmarkResult,
  ): ActionBenchmarkResult => {
    if (runsPerCase === 1) return result;
    return {
      ...result,
      runIndex: item.runIndex,
      runsPerCase,
      // Restore the original case id so reliability grouping + tag stats
      // work on the natural case identity, not the synthetic per-run id.
      case: { ...result.case, id: item.originalId },
    };
  };

  if (concurrency === 1) {
    let first = true;
    for (const item of scheduled) {
      if (!first && throttleMs > 0) await sleep(throttleMs);
      first = false;
      const res = await runOneWithRetries(item.case);
      results.push(stampReliability(item, res));
    }
  } else {
    let cursor = 0;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i += 1) {
      workers.push(
        (async () => {
          while (cursor < scheduled.length) {
            const myIdx = cursor;
            cursor += 1;
            const item = scheduled[myIdx];
            if (!item) break;
            const res = await runOneWithRetries(item.case);
            results[myIdx] = stampReliability(item, res);
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

  let reliability: CaseReliability[] | undefined;
  if (runsPerCase > 1) {
    const grouped = new Map<string, ActionBenchmarkResult[]>();
    for (const r of results) {
      const id = r.case.id;
      const bucket = grouped.get(id) ?? [];
      bucket.push(r);
      grouped.set(id, bucket);
    }
    reliability = [...grouped.entries()]
      .map(([caseId, runs]) => {
        const passes = runs.filter((r) => r.pass).length;
        const expectedAction = runs[0]?.case.expectedAction ?? null;
        const actuals = runs.map((r) => r.actualAction);
        return {
          caseId,
          expectedAction,
          runs: runs.length,
          passes,
          passRate: runs.length === 0 ? 0 : passes / runs.length,
          actuals,
        };
      })
      .sort((a, b) => {
        if (a.passRate !== b.passRate) return a.passRate - b.passRate;
        return a.caseId.localeCompare(b.caseId);
      });
  }

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
    cache: summarizeCacheStats(results),
    reliability,
    runsPerCase: runsPerCase > 1 ? runsPerCase : undefined,
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
      const markdownLink = `cases/${r.case.id}.md`;
      const colour = r.pass ? "#0a7" : "#c33";
      return `<tr>
  <td><a href="${link}">${escapeHtml(r.case.id)}</a></td>
  <td><a href="${markdownLink}">markdown</a></td>
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
<thead><tr><th>Case</th><th>Review</th><th>Result</th><th>Expected</th><th>Planned</th><th>Completed</th><th>Latency</th><th>Tags</th></tr></thead>
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
  if (report.cache) {
    lines.push(
      `**LLM Token Usage:** input ${report.cache.promptTokens} · output ${report.cache.completionTokens} · total ${report.cache.totalTokens} (${report.cache.llmCallsWithUsage}/${report.cache.llmCalls} calls reported usage)`,
    );
    lines.push(
      `**Cache Read:** ${(report.cache.cacheReadInputRatio * 100).toFixed(1)}% (${report.cache.cacheReadInputTokens}/${report.cache.promptTokens} input tokens)`,
    );
    lines.push(
      `**Cache Write:** ${(report.cache.cacheCreationInputRatio * 100).toFixed(1)}% (${report.cache.cacheCreationInputTokens}/${report.cache.promptTokens} input tokens)`,
    );
  }
  lines.push("");

  if (report.reliability && report.runsPerCase && report.runsPerCase > 1) {
    const N = report.runsPerCase;
    const buckets = new Map<number, typeof report.reliability>();
    for (let i = 0; i <= N; i += 1) buckets.set(i, []);
    for (const r of report.reliability) {
      const bucket = buckets.get(r.passes);
      if (bucket) bucket.push(r);
    }
    lines.push(`## Reliability (${N} runs per case)`);
    lines.push("");
    lines.push("| Pass-rate | Cases | % of total |");
    lines.push("| --- | ---: | ---: |");
    for (let i = N; i >= 0; i -= 1) {
      const bucket = buckets.get(i) ?? [];
      const pct =
        report.reliability.length === 0
          ? 0
          : (bucket.length / report.reliability.length) * 100;
      lines.push(`| ${i}/${N} | ${bucket.length} | ${pct.toFixed(1)}% |`);
    }
    lines.push("");
    const flaky = report.reliability.filter(
      (r) => r.passes > 0 && r.passes < N,
    );
    const broken = report.reliability.filter((r) => r.passes === 0);
    if (broken.length > 0) {
      lines.push(`### Deterministic broken (0/${N})`);
      lines.push("");
      lines.push("| Case | Expected | Actuals across runs |");
      lines.push("| --- | --- | --- |");
      for (const r of broken) {
        const actuals = r.actuals.map((a) => a ?? "(none)").join(" \\| ");
        lines.push(
          `| ${r.caseId} | ${r.expectedAction ?? "(none)"} | ${actuals} |`,
        );
      }
      lines.push("");
    }
    if (flaky.length > 0) {
      lines.push(`### Flaky (1..${N - 1}/${N})`);
      lines.push("");
      lines.push("| Case | Pass-rate | Expected | Actuals across runs |");
      lines.push("| --- | ---: | --- | --- |");
      for (const r of flaky) {
        const actuals = r.actuals.map((a) => a ?? "(none)").join(" \\| ");
        lines.push(
          `| ${r.caseId} | ${r.passes}/${r.runs} | ${r.expectedAction ?? "(none)"} | ${actuals} |`,
        );
      }
      lines.push("");
    }
  }

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
      const err = f.error
        ? f.error.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
        : "";
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
      const issueErr = (result.error ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|");
      lines.push(
        `| ${result.case.id} | ${result.plannedAction ?? "(none)"} | ${result.startedAction ?? "(none)"} | ${result.completedAction ?? "(none)"} | ${issueErr} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
