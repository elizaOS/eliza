/**
 * Registry of finalCheck handlers keyed by the discriminator string from
 * `ScenarioFinalCheck.type`. Unknown kinds fail loudly so scenario proof fields
 * cannot be misspelled or silently skipped.
 */

import { createHash } from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import {
  type CapturedConnectorDispatch,
  FINAL_CHECK_KEYS,
  type ScenarioContext,
  type ScenarioFinalCheck,
} from "@elizaos/scenario-runner/schema";
import type {
  FinalCheckReport,
  FinalCheckStatus,
  ScenarioEvidenceObservation,
  ScenarioEvidenceReport,
} from "../types.ts";
import { isLoopbackUrl, toRecord } from "../utils.js";

export type FinalCheckRuntime = {
  getService?: (name: string) => unknown;
  getServicesByType?: (name: string) => unknown;
};

const REMINDER_LIFECYCLE_METADATA_KEY = "lifecycle";
const REMINDER_ESCALATION_INDEX_METADATA_KEY = "escalationIndex";
const MODEL_CALL_OCCURRED_SETTLE_TIMEOUT_MS = 2500;
const MODEL_CALL_OCCURRED_POLL_INTERVAL_MS = 50;

export interface FinalCheckHandlerContext {
  runtime: FinalCheckRuntime;
  ctx: ScenarioContext;
  trustedEvidence?: ScenarioEvidenceReport;
  scenarioStartedAtIso?: string;
  scenarioEndedAtIso?: string;
}

type FinalCheckOutcome =
  | { status: "passed"; detail: string }
  | { status: "failed"; detail: string }
  /**
   * The check's runtime dependency is missing. Never a silent pass: the
   * executor fails the scenario in the pr-deterministic lane and reports
   * count skips loudly in live lanes.
   */
  | { status: "skipped"; detail: string };

type FinalCheckHandler = (
  check: ScenarioFinalCheck,
  ctx: FinalCheckHandlerContext,
) => Promise<FinalCheckOutcome> | FinalCheckOutcome;

const HANDLERS = new Map<string, FinalCheckHandler>();

function registerFinalCheckHandler(
  type: string,
  handler: FinalCheckHandler,
): void {
  HANDLERS.set(type, handler);
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function matchesPattern(value: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
  pattern.lastIndex = 0;
  return pattern.test(value);
}

type TrajectoryLlmCallLike = {
  purpose?: string;
  userPrompt?: string;
  systemPrompt?: string;
  prompt?: string;
  response?: string;
  model?: string;
  modelName?: string;
  modelType?: string;
  provider?: string;
  [key: string]: unknown;
};

type TrajectoryDetailLike = {
  trajectoryId?: string;
  scenarioId?: string;
  steps?: Array<{
    llmCalls?: TrajectoryLlmCallLike[];
  }>;
};

type TrajectoryServiceLike = {
  listTrajectories(options?: {
    limit?: number;
    offset?: number;
    scenarioId?: string;
  }): Promise<{
    trajectories?: Array<{
      id?: string;
      trajectoryId?: string;
      scenarioId?: string;
      startTime?: number;
    }>;
  }>;
  getTrajectoryDetail(id: string): Promise<TrajectoryDetailLike | null>;
  flushWriteQueue?: (trajectoryId: string) => Promise<void> | void;
  writeQueues?: Map<string, unknown>;
};

function resolveTrajectoryService(
  runtime: FinalCheckRuntime,
): TrajectoryServiceLike | null {
  const candidates: unknown[] = [];
  if (typeof runtime.getServicesByType === "function") {
    const value = runtime.getServicesByType("trajectories");
    if (Array.isArray(value)) {
      candidates.push(...value);
    } else if (value) {
      candidates.push(value);
    }
  }
  if (typeof runtime.getService === "function") {
    candidates.push(runtime.getService("trajectories"));
  }

  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "listTrajectories" in candidate &&
      typeof candidate.listTrajectories === "function" &&
      "getTrajectoryDetail" in candidate &&
      typeof candidate.getTrajectoryDetail === "function"
    ) {
      return candidate as TrajectoryServiceLike;
    }
  }
  return null;
}

function collectTrajectoryLlmCalls(
  detail: TrajectoryDetailLike | null,
): TrajectoryLlmCallLike[] {
  if (!detail?.steps?.length) {
    return [];
  }
  return detail.steps.flatMap((step) =>
    Array.isArray(step.llmCalls) ? step.llmCalls : [],
  );
}

function modelCallBlob(call: TrajectoryLlmCallLike): string {
  return [
    call.purpose,
    call.userPrompt,
    call.systemPrompt,
    call.prompt,
    call.response,
    call.model,
    call.modelName,
    call.modelType,
    call.provider,
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "then" in value &&
    typeof value.then === "function"
  );
}

async function settleTrajectoryWrites(
  service: TrajectoryServiceLike,
): Promise<void> {
  if (service.writeQueues instanceof Map && service.writeQueues.size > 0) {
    await Promise.allSettled(
      [...service.writeQueues.values()]
        .filter(isPromiseLike)
        .map((pending) => Promise.resolve(pending)),
    );
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function flushListedTrajectoryWrites(
  service: TrajectoryServiceLike,
  ids: string[],
): Promise<void> {
  if (typeof service.flushWriteQueue !== "function" || ids.length === 0) {
    return;
  }
  await Promise.allSettled(ids.map((id) => service.flushWriteQueue?.(id)));
}

function supportsAsyncTrajectoryFlush(service: TrajectoryServiceLike): boolean {
  return (
    typeof service.flushWriteQueue === "function" ||
    service.writeQueues instanceof Map
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type MatchingModelCallSearch = {
  matchingCalls: TrajectoryLlmCallLike[];
  observedPurposes: Set<string>;
};

async function collectMatchingModelCalls(
  service: TrajectoryServiceLike,
  options: {
    scenarioId?: string;
    acceptedPurposes: string[];
    includesAny?: Array<string | RegExp>;
    includesAll?: Array<string | RegExp>;
    requiredCount: number;
  },
): Promise<MatchingModelCallSearch> {
  await settleTrajectoryWrites(service);

  const list = await service.listTrajectories({
    limit: Math.max(25, options.requiredCount * 5),
    ...(options.scenarioId ? { scenarioId: options.scenarioId } : {}),
  });
  const ids = (list.trajectories ?? [])
    .map((entry) => entry.id ?? entry.trajectoryId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  await flushListedTrajectoryWrites(service, ids);

  const matchingCalls: TrajectoryLlmCallLike[] = [];
  const observedPurposes = new Set<string>();
  for (const id of ids) {
    const detail = await service.getTrajectoryDetail(id);
    if (
      options.scenarioId &&
      detail?.scenarioId &&
      detail.scenarioId !== options.scenarioId
    ) {
      continue;
    }
    for (const call of collectTrajectoryLlmCalls(detail)) {
      if (call.purpose) {
        observedPurposes.add(call.purpose);
      }
      if (
        options.acceptedPurposes.length > 0 &&
        !options.acceptedPurposes.includes(String(call.purpose ?? ""))
      ) {
        continue;
      }
      const blob = modelCallBlob(call);
      if (
        options.includesAll?.length &&
        options.includesAll.some((pattern) => !matchesPattern(blob, pattern))
      ) {
        continue;
      }
      if (
        options.includesAny?.length &&
        !options.includesAny.some((pattern) => matchesPattern(blob, pattern))
      ) {
        continue;
      }
      matchingCalls.push(call);
    }
  }

  return { matchingCalls, observedPurposes };
}

async function waitForMatchingModelCalls(
  service: TrajectoryServiceLike,
  options: {
    scenarioId?: string;
    acceptedPurposes: string[];
    includesAny?: Array<string | RegExp>;
    includesAll?: Array<string | RegExp>;
    requiredCount: number;
  },
): Promise<MatchingModelCallSearch> {
  const shouldPoll = supportsAsyncTrajectoryFlush(service);
  const deadline = Date.now() + MODEL_CALL_OCCURRED_SETTLE_TIMEOUT_MS;
  let result = await collectMatchingModelCalls(service, options);

  while (
    shouldPoll &&
    result.matchingCalls.length < options.requiredCount &&
    Date.now() < deadline
  ) {
    await sleep(MODEL_CALL_OCCURRED_POLL_INTERVAL_MS);
    result = await collectMatchingModelCalls(service, options);
  }

  return result;
}

function matchesActionName(
  value: string,
  accepted: string | string[] | undefined,
): boolean {
  if (accepted === undefined) {
    return true;
  }
  return toArray(accepted).includes(value);
}

function normalizeChannel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

function normalizeComparableText(value: string): string {
  // Dashes fold to spaces so hyphenation never defeats a loose title match:
  // live models legitimately title a "before school" routine
  // "Before-school routine" (#16941).
  return value.trim().toLowerCase().replace(/[-–—]/g, " ").replace(/\s+/g, " ");
}

function textMatchesLoose(actual: string, expected: string): boolean {
  const normalizedActual = normalizeComparableText(actual);
  const normalizedExpected = normalizeComparableText(expected);
  return (
    normalizedActual === normalizedExpected ||
    normalizedActual.includes(normalizedExpected) ||
    normalizedExpected.includes(normalizedActual)
  );
}

function matchesChannel(
  value: string | undefined,
  accepted: string | string[] | undefined,
): boolean {
  if (accepted === undefined) {
    return true;
  }
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const normalizedValue = normalizeChannel(value);
  return toArray(accepted).some(
    (candidate) => normalizeChannel(candidate) === normalizedValue,
  );
}

/** Action-result guesses are useful diagnostics, never side-effect evidence. */
function isBindingConnectorDispatch(
  dispatch: CapturedConnectorDispatch,
): boolean {
  return dispatch.evidenceSource !== "action-result-inference";
}

function selectedTurnExecutions(
  ctx: ScenarioContext,
  turn: string | string[] | undefined,
): NonNullable<ScenarioContext["turns"]> {
  const turns = ctx.turns ?? [];
  if (turn === undefined) return turns;
  const accepted = toArray(turn);
  return turns.filter(
    (execution) =>
      typeof execution.name === "string" && accepted.includes(execution.name),
  );
}

function connectorDispatchesForTurn(
  ctx: ScenarioContext,
  turn: string | string[] | undefined,
): CapturedConnectorDispatch[] {
  if (turn === undefined) return ctx.connectorDispatches ?? [];
  return selectedTurnExecutions(ctx, turn).flatMap(
    (execution) => execution.connectorDispatches ?? [],
  );
}

function actionsForTurn(
  ctx: ScenarioContext,
  turn: string | string[] | undefined,
): ScenarioContext["actionsCalled"] {
  if (turn === undefined) return ctx.actionsCalled;
  return selectedTurnExecutions(ctx, turn).flatMap(
    (execution) => execution.actionsCalled,
  );
}

function actionParameters(
  action: ScenarioContext["actionsCalled"][number],
): Record<string, unknown> | null {
  const params = toRecord(action.parameters);
  return toRecord(params?.parameters) ?? params;
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return expected.some((candidate) => valuesEqual(actual, candidate));
  }
  if (Array.isArray(actual)) {
    return actual.some((candidate) => valuesEqual(candidate, expected));
  }
  if (
    actual &&
    expected &&
    typeof actual === "object" &&
    typeof expected === "object"
  ) {
    const actualRecord = toRecord(actual);
    const expectedRecord = toRecord(expected);
    if (!actualRecord || !expectedRecord) {
      return false;
    }
    return Object.entries(expectedRecord).every(([key, value]) =>
      valuesEqual(actualRecord[key], value),
    );
  }
  return actual === expected;
}

function valuesEqualWithExactArrays(
  actual: unknown,
  expected: unknown,
): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return false;
    }
    const unmatched = [...actual];
    for (const expectedEntry of expected) {
      const index = unmatched.findIndex((actualEntry) =>
        valuesEqualWithExactArrays(actualEntry, expectedEntry),
      );
      if (index < 0) return false;
      unmatched.splice(index, 1);
    }
    return unmatched.length === 0;
  }
  if (
    actual &&
    expected &&
    typeof actual === "object" &&
    typeof expected === "object"
  ) {
    const actualRecord = toRecord(actual);
    const expectedRecord = toRecord(expected);
    if (!actualRecord || !expectedRecord) return false;
    return Object.entries(expectedRecord).every(([key, value]) =>
      valuesEqualWithExactArrays(actualRecord[key], value),
    );
  }
  return actual === expected;
}

function matchesExpectedFieldsWithArrayPolicy(
  actual: unknown,
  expected: Record<string, unknown> | undefined,
  exactArrays: boolean,
): boolean {
  if (!exactArrays) return matchesExpectedFields(actual, expected);
  if (!expected) return true;
  const actualRecord = toRecord(actual);
  if (!actualRecord) return false;
  return Object.entries(expected).every(([key, value]) =>
    valuesEqualWithExactArrays(actualRecord[key], value),
  );
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    const record = toRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[segment];
  }
  return current;
}

function matchesExpectedFields(
  value: unknown,
  expected: Record<string, unknown> | undefined,
): boolean {
  if (!expected) {
    return true;
  }
  return Object.entries(expected).every(([path, expectedValue]) =>
    valuesEqual(readPath(value, path), expectedValue),
  );
}

function matchesContentMatcher(actual: unknown, expected: unknown): boolean {
  const expectedRecord = toRecord(expected);
  if (expectedRecord) {
    if (Object.hasOwn(expectedRecord, "$contains")) {
      const needle = expectedRecord.$contains;
      if (typeof needle !== "string" && !(needle instanceof RegExp)) {
        return false;
      }
      const haystack =
        typeof actual === "string" ? actual : JSON.stringify(actual ?? "");
      return matchesPattern(haystack, needle);
    }
    const actualRecord = toRecord(actual);
    if (!actualRecord) {
      return false;
    }
    return Object.entries(expectedRecord).every(([key, value]) =>
      matchesContentMatcher(actualRecord[key], value),
    );
  }
  if (Array.isArray(expected)) {
    return expected.some((candidate) =>
      matchesContentMatcher(actual, candidate),
    );
  }
  return valuesEqual(actual, expected);
}

function recordHasEntries(value: unknown): boolean {
  const record = toRecord(value);
  return Boolean(record && Object.keys(record).length > 0);
}

function isGoalRecord(value: unknown): value is Record<string, unknown> {
  const record = toRecord(value);
  return typeof record?.title === "string" && record.title.trim().length > 0;
}

function goalRecordFromActionResult(
  value: unknown,
): Record<string, unknown> | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }
  if (isGoalRecord(record.goal)) {
    return toRecord(record.goal);
  }
  const wrappedRecord = toRecord(record.record);
  if (isGoalRecord(wrappedRecord?.goal)) {
    return toRecord(wrappedRecord.goal);
  }
  return null;
}

type DefinitionCountCheck = {
  title?: string;
  titleAliases?: string[];
  delta?: number;
  cadenceKind?: string;
  requiredSlots?: Array<{ label?: string; minuteOfDay?: number }>;
  requiredWeekdays?: number[];
  requiredWindows?: string[];
  requiredEveryMinutes?: number;
  requiredMaxOccurrencesPerDay?: number;
  expectedTimeZone?: string;
  expectedDueLocalTimes?: Array<{
    hour?: number;
    minute?: number;
    timeZone?: string;
  }>;
  forbiddenDueLocalTimes?: Array<{
    hour?: number;
    minute?: number;
    timeZone?: string;
  }>;
  requireReminderPlan?: boolean;
  websiteAccess?: Record<string, unknown>;
};

type DefinitionRecordLike = {
  definition: Record<string, unknown>;
  reminderPlan: unknown;
};

type DefinitionListingService = {
  listDefinitions(): Promise<unknown[]>;
};

function isDefinitionListingService(
  value: unknown,
): value is DefinitionListingService {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (!("listDefinitions" in value)) {
    return false;
  }
  return typeof value.listDefinitions === "function";
}

async function createLifeOpsService(
  runtime: FinalCheckRuntime,
): Promise<unknown> {
  const lifeOpsServicePackage: string =
    "@elizaos/plugin-personal-assistant/lifeops/service";
  const { LifeOpsService } = (await import(lifeOpsServicePackage)) as {
    LifeOpsService: new (runtime: IAgentRuntime) => unknown;
  };
  // Scenario final checks receive the live agent runtime; FinalCheckRuntime is
  // the structural subset they need, but LifeOpsService requires the full one.
  return new LifeOpsService(runtime as IAgentRuntime);
}

function definitionRecordFromValue(
  value: unknown,
): DefinitionRecordLike | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }
  const definition = toRecord(record.definition) ?? record;
  if (typeof definition.title !== "string") {
    return null;
  }
  return {
    definition,
    reminderPlan: record.reminderPlan ?? definition.reminderPlan ?? null,
  };
}

function definitionTitleMatches(
  definition: Record<string, unknown>,
  check: DefinitionCountCheck,
): boolean {
  if (typeof check.title !== "string" || check.title.trim().length === 0) {
    return false;
  }
  if (typeof definition.title !== "string") {
    return false;
  }
  const actualTitle = definition.title;
  const accepted = [check.title, ...(check.titleAliases ?? [])];
  return accepted.some((title) => textMatchesLoose(actualTitle, title));
}

function requiredSlotMatches(
  actualSlot: unknown,
  expectedSlot: { label?: string; minuteOfDay?: number },
): boolean {
  const actual = toRecord(actualSlot);
  if (!actual) {
    return false;
  }
  if (
    typeof expectedSlot.minuteOfDay === "number" &&
    actual.minuteOfDay !== expectedSlot.minuteOfDay
  ) {
    return false;
  }
  if (typeof expectedSlot.label === "string") {
    return (
      typeof actual.label === "string" &&
      textMatchesLoose(actual.label, expectedSlot.label)
    );
  }
  return true;
}

function arrayContainsAllValues(actual: unknown, expected: unknown[]): boolean {
  if (!Array.isArray(actual)) {
    return false;
  }
  return expected.every((expectedValue) =>
    actual.some((actualValue) =>
      looselyMatchesValue(actualValue, expectedValue),
    ),
  );
}

function looselyMatchesValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return arrayContainsAllValues(actual, expected);
  }
  const expectedRecord = toRecord(expected);
  if (expectedRecord) {
    const actualRecord = toRecord(actual);
    return Boolean(
      actualRecord &&
        Object.entries(expectedRecord).every(([key, value]) =>
          looselyMatchesValue(actualRecord[key], value),
        ),
    );
  }
  if (typeof expected === "string") {
    return (
      typeof actual === "string" &&
      normalizeComparableText(actual) === normalizeComparableText(expected)
    );
  }
  return actual === expected;
}

function localHourMinuteForInstant(
  dueAt: unknown,
  timeZone: unknown,
): { hour: number; minute: number } | null {
  if (typeof dueAt !== "string" || typeof timeZone !== "string") {
    return null;
  }
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const hourPart = parts.find((part) => part.type === "hour")?.value;
    const minutePart = parts.find((part) => part.type === "minute")?.value;
    if (hourPart === undefined || minutePart === undefined) {
      return null;
    }
    const parsedHour = Number(hourPart);
    const parsedMinute = Number(minutePart);
    if (Number.isNaN(parsedHour) || Number.isNaN(parsedMinute)) {
      return null;
    }
    return { hour: parsedHour % 24, minute: parsedMinute };
  } catch {
    return null;
  }
}

function definitionMismatchReasons(
  record: DefinitionRecordLike,
  check: DefinitionCountCheck,
): string[] {
  const reasons: string[] = [];
  const cadence = toRecord(record.definition.cadence);
  if (
    typeof check.cadenceKind === "string" &&
    cadence?.kind !== check.cadenceKind
  ) {
    reasons.push(
      `cadence.kind expected ${check.cadenceKind}, saw ${String(cadence?.kind ?? "missing")}`,
    );
  }
  if (
    typeof check.expectedTimeZone === "string" &&
    record.definition.timezone !== check.expectedTimeZone
  ) {
    reasons.push(
      `timezone expected ${check.expectedTimeZone}, saw ${String(record.definition.timezone ?? "missing")}`,
    );
  }
  if (
    Array.isArray(check.expectedDueLocalTimes) &&
    check.expectedDueLocalTimes.length > 0
  ) {
    const dueAt = cadence?.dueAt;
    const expectedLocalTimes = check.expectedDueLocalTimes.filter(
      (expected) => typeof expected.hour === "number",
    );
    const observedLocalTimes = expectedLocalTimes.map((expected) => {
      const timeZone = expected.timeZone ?? record.definition.timezone;
      return {
        expected,
        timeZone,
        local: localHourMinuteForInstant(dueAt, timeZone),
      };
    });
    if (observedLocalTimes.some(({ local }) => !local)) {
      reasons.push(
        `dueAt local time unavailable for ${String(dueAt ?? "missing")}`,
      );
    } else if (
      !observedLocalTimes.some(({ expected, local }) => {
        const minute = expected.minute ?? 0;
        return local?.hour === expected.hour && local?.minute === minute;
      })
    ) {
      const expectedText = expectedLocalTimes
        .map((expected) => {
          const timeZone = expected.timeZone ?? record.definition.timezone;
          return `${String(expected.hour).padStart(2, "0")}:${String(expected.minute ?? 0).padStart(2, "0")} in ${String(timeZone)}`;
        })
        .join(" or ");
      const observedText = observedLocalTimes
        .map(({ local, timeZone }) =>
          local
            ? `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")} in ${String(timeZone)}`
            : `unavailable in ${String(timeZone)}`,
        )
        .join(", ");
      reasons.push(
        `dueAt local time expected ${expectedText}, saw ${observedText}`,
      );
    }
  }
  if (Array.isArray(check.requiredSlots) && check.requiredSlots.length > 0) {
    const slots = Array.isArray(cadence?.slots) ? cadence.slots : [];
    for (const slot of check.requiredSlots) {
      if (!slots.some((actualSlot) => requiredSlotMatches(actualSlot, slot))) {
        reasons.push(`missing required slot ${JSON.stringify(slot)}`);
      }
    }
  }
  if (
    Array.isArray(check.requiredWeekdays) &&
    check.requiredWeekdays.length > 0 &&
    !arrayContainsAllValues(cadence?.weekdays, check.requiredWeekdays)
  ) {
    reasons.push(`weekdays missing [${check.requiredWeekdays.join(", ")}]`);
  }
  if (
    Array.isArray(check.requiredWindows) &&
    check.requiredWindows.length > 0 &&
    !arrayContainsAllValues(cadence?.windows, check.requiredWindows)
  ) {
    reasons.push(`windows missing [${check.requiredWindows.join(", ")}]`);
  }
  if (
    typeof check.requiredEveryMinutes === "number" &&
    cadence?.everyMinutes !== check.requiredEveryMinutes
  ) {
    reasons.push(
      `everyMinutes expected ${check.requiredEveryMinutes}, saw ${String(cadence?.everyMinutes ?? "missing")}`,
    );
  }
  if (
    typeof check.requiredMaxOccurrencesPerDay === "number" &&
    cadence?.maxOccurrencesPerDay !== check.requiredMaxOccurrencesPerDay
  ) {
    reasons.push(
      `maxOccurrencesPerDay expected ${check.requiredMaxOccurrencesPerDay}, saw ${String(cadence?.maxOccurrencesPerDay ?? "missing")}`,
    );
  }
  if (
    Array.isArray(check.forbiddenDueLocalTimes) &&
    check.forbiddenDueLocalTimes.length > 0
  ) {
    const dueAt = cadence?.dueAt;
    const slots = Array.isArray(cadence?.slots) ? cadence.slots : [];
    for (const forbidden of check.forbiddenDueLocalTimes) {
      if (typeof forbidden.hour !== "number") {
        continue;
      }
      const forbiddenMinute = forbidden.minute ?? 0;
      // Slot-based cadences (times_per_day) encode timezone-local clock times
      // as minuteOfDay directly — no due instant exists to convert.
      const forbiddenMinuteOfDay = forbidden.hour * 60 + forbiddenMinute;
      if (slots.length > 0) {
        if (
          slots.some(
            (slot) => toRecord(slot)?.minuteOfDay === forbiddenMinuteOfDay,
          )
        ) {
          reasons.push(
            `slot at local time ${String(forbidden.hour).padStart(2, "0")}:${String(forbiddenMinute).padStart(2, "0")} is forbidden`,
          );
        }
        continue;
      }
      if (typeof dueAt !== "string" && cadence?.kind !== "once") {
        // Window/interval cadences carry no explicit clock time at all, so
        // there is nothing at the forbidden instant — "missing" here is not a
        // broken pipeline, it is a cadence shape without due instants.
        continue;
      }
      const timeZone = forbidden.timeZone ?? record.definition.timezone;
      const local = localHourMinuteForInstant(dueAt, timeZone);
      if (!local) {
        reasons.push(
          `dueAt local time unavailable for ${String(dueAt ?? "missing")} in ${String(timeZone ?? "missing timezone")}`,
        );
        continue;
      }
      const minute = forbidden.minute ?? 0;
      if (local.hour === forbidden.hour && local.minute === minute) {
        reasons.push(
          `dueAt local time ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")} in ${String(timeZone)} is forbidden`,
        );
      }
    }
  }
  if (typeof check.requireReminderPlan === "boolean") {
    const hasReminderPlan =
      recordHasEntries(record.reminderPlan) ||
      (typeof record.definition.reminderPlanId === "string" &&
        record.definition.reminderPlanId.length > 0);
    if (hasReminderPlan !== check.requireReminderPlan) {
      reasons.push(
        `reminderPlan expected ${check.requireReminderPlan}, saw ${hasReminderPlan}`,
      );
    }
  }
  if (check.websiteAccess) {
    const websiteAccess = toRecord(record.definition.websiteAccess);
    if (!websiteAccess) {
      reasons.push("websiteAccess missing");
    } else if (!looselyMatchesValue(websiteAccess, check.websiteAccess)) {
      reasons.push("websiteAccess did not match expected fields");
    }
  }
  return reasons;
}

/**
 * Compact receipt line for one persisted definition row. Pass details embed
 * these so a report reader can inspect the actual stored artifact (title,
 * cadence, due instant, timezone, reminder-plan presence) instead of trusting
 * a bare match count — the evidence bar for catalog verification is "store
 * rows shown, not just asserted".
 */
function definitionReceipt(record: DefinitionRecordLike): string {
  const cadence = toRecord(record.definition.cadence);
  const parts = [`"${String(record.definition.title ?? "(untitled)")}"`];
  if (cadence?.kind !== undefined) {
    parts.push(`cadence=${String(cadence.kind)}`);
  }
  if (typeof cadence?.dueAt === "string") {
    parts.push(`dueAt=${cadence.dueAt}`);
  }
  if (Array.isArray(cadence?.slots) && cadence.slots.length > 0) {
    const slotText = cadence.slots
      .map((slot) => {
        const slotRecord = toRecord(slot);
        return typeof slotRecord?.minuteOfDay === "number"
          ? `${String(Math.floor(slotRecord.minuteOfDay / 60)).padStart(2, "0")}:${String(slotRecord.minuteOfDay % 60).padStart(2, "0")}`
          : "?";
      })
      .join(",");
    parts.push(`slots=[${slotText}]`);
  }
  if (typeof record.definition.timezone === "string") {
    parts.push(`tz=${record.definition.timezone}`);
  }
  const planEntries = toRecord(record.reminderPlan);
  const planSteps = Array.isArray(planEntries?.steps)
    ? planEntries.steps
        .map((step) => {
          const stepRecord = toRecord(step);
          return typeof stepRecord?.offsetMinutes === "number"
            ? `${stepRecord.offsetMinutes}m`
            : "?";
        })
        .join(",")
    : null;
  const planLeads = Array.isArray(planEntries?.leadMinutes)
    ? `leadMinutes=[${planEntries.leadMinutes.join(",")}]`
    : planSteps !== null && planSteps.length > 0
      ? // Step offsets are the stored artifact for "nudge me before it's due
        // too" asks (negative = minutes before the anchor), so the receipt
        // shows them instead of a bare presence flag.
        `steps=[${planSteps}]`
      : recordHasEntries(record.reminderPlan)
        ? "present"
        : typeof record.definition.reminderPlanId === "string" &&
            record.definition.reminderPlanId.length > 0
          ? `id=${record.definition.reminderPlanId}`
          : "none";
  parts.push(`reminderPlan=${planLeads}`);
  return parts.join(" ");
}

type GmailMockRequest = {
  environment?: string;
  method?: string;
  path?: string;
  query?: string;
  body?: unknown;
  createdAt?: string;
  gmail?: unknown;
};

type GmailRequestEvidence =
  | { requests: GmailMockRequest[]; error?: never }
  | { requests?: never; error: string };

function gmailMockRequestsForTurn(
  ctx: ScenarioContext,
  turn: string | string[] | undefined,
): GmailRequestEvidence | null {
  if (turn === undefined) return null;
  const requestedTurns = toArray(turn);
  const executions = selectedTurnExecutions(ctx, turn);
  const observedNames = new Set(executions.map((execution) => execution.name));
  const missingTurns = requestedTurns.filter(
    (name) => !observedNames.has(name),
  );
  if (missingTurns.length > 0) {
    return {
      error: `turn-scoped Gmail provider evidence is missing turn(s): ${missingTurns.join(", ")}`,
    };
  }
  const missingLedgers = executions
    .filter((execution) => execution.providerRequests === undefined)
    .map((execution) => execution.name ?? "(unnamed)");
  if (missingLedgers.length > 0) {
    return {
      error: `turn-scoped Gmail provider ledger unavailable for: ${missingLedgers.join(", ")}`,
    };
  }
  return {
    requests: executions.flatMap((execution) =>
      (execution.providerRequests ?? [])
        .filter((request) => request.provider === "gmail")
        .map((request) => ({
          environment: request.environment,
          method: request.method,
          path: request.path,
          query: request.query,
          body: request.body,
          createdAt: request.createdAt,
          gmail: request.metadata,
        })),
    ),
  };
}

async function readGmailMockRequests(): Promise<GmailMockRequest[]> {
  const base = process.env.ELIZA_MOCK_GOOGLE_BASE;
  if (!isLoopbackUrl(base)) {
    throw new Error(
      "ELIZA_MOCK_GOOGLE_BASE must be a loopback URL for Gmail ledger checks",
    );
  }
  const response = await fetch(`${base}/__mock/requests`);
  if (!response.ok) {
    throw new Error(
      `Gmail mock request ledger returned HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as { requests?: unknown };
  return Array.isArray(body.requests)
    ? body.requests.filter(
        (entry): entry is GmailMockRequest =>
          Boolean(entry) && typeof entry === "object",
      )
    : [];
}

async function resolveGmailMockRequests(
  ctx: ScenarioContext,
  turn: string | string[] | undefined,
): Promise<GmailRequestEvidence> {
  const turnEvidence = gmailMockRequestsForTurn(ctx, turn);
  if (turnEvidence !== null) return turnEvidence;
  try {
    return { requests: await readGmailMockRequests() };
  } catch (error) {
    return {
      error: `Gmail mock request evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function gmailRequestMatches(
  entry: GmailMockRequest,
  filters: {
    method?: string | string[];
    path?: string | string[];
    body?: Record<string, unknown>;
    gmail?: Record<string, unknown>;
    exactArrays?: boolean;
  },
): boolean {
  if (
    filters.method !== undefined &&
    !toArray(filters.method).includes(String(entry.method ?? "").toUpperCase())
  ) {
    return false;
  }
  if (
    filters.path !== undefined &&
    !toArray(filters.path).includes(String(entry.path ?? ""))
  ) {
    return false;
  }
  return (
    matchesExpectedFieldsWithArrayPolicy(
      entry.body,
      filters.body,
      filters.exactArrays === true,
    ) &&
    matchesExpectedFieldsWithArrayPolicy(
      entry.gmail,
      filters.gmail,
      filters.exactArrays === true,
    )
  );
}

function gmailSendLedgerPaths(): string[] {
  return ["/gmail/v1/users/me/messages/send", "/gmail/v1/users/me/drafts/send"];
}

function hasGmailDraftData(
  action: ScenarioContext["actionsCalled"][number],
): boolean {
  const data = actionResultData(action);
  return Boolean(
    data?.gmailDraft ||
      (matchesChannel(String(data?.source ?? ""), "gmail") &&
        typeof data?.draftId === "string" &&
        data.draftId.length > 0),
  );
}

function hasConfirmedGmailSendAction(
  action: ScenarioContext["actionsCalled"][number],
): boolean {
  const acceptedNames = new Set(["MESSAGE", "GMAIL_ACTION", "INBOX"]);
  if (!acceptedNames.has(action.actionName)) {
    return false;
  }
  const params = actionParameters(action);
  return (
    params?.confirmed === true ||
    readPath(params, "details.confirmSend") === true
  );
}

function hasRecursiveObjectMatch(
  value: unknown,
  predicate: (record: Record<string, unknown>) => boolean,
): boolean {
  const record = toRecord(value);
  if (!record) {
    if (Array.isArray(value)) {
      return value.some((entry) => hasRecursiveObjectMatch(entry, predicate));
    }
    return false;
  }
  if (predicate(record)) {
    return true;
  }
  return Object.values(record).some((entry) =>
    hasRecursiveObjectMatch(entry, predicate),
  );
}

function actionResultData(
  action: ScenarioContext["actionsCalled"][number],
): Record<string, unknown> | null {
  return toRecord(action.result?.data) ?? toRecord(action.result?.raw);
}

/**
 * A synthesized REPLY is fabricated by the executor when the runtime emitted
 * conversational text but the LLM did not actually select an action. It is NOT
 * a genuine action selection, so action-selection checks must not be satisfied
 * by it — otherwise a turn that free-texts instead of selecting the required
 * action would falsely pass.
 */
function isSynthesizedReply(
  action: ScenarioContext["actionsCalled"][number],
): boolean {
  return toRecord(action.result?.data)?.source === "synthesized-reply";
}

function hasBrowserTaskCompletedValue(value: unknown): boolean {
  const record = toRecord(value);
  if (!record) {
    return false;
  }
  const browserTask = toRecord(record.browserTask);
  if (browserTask?.completed === true) {
    return true;
  }
  const cancellation = toRecord(record.cancellation);
  if (cancellation?.status === "completed") {
    return true;
  }
  const session = toRecord(record.session);
  return session?.status === "done";
}

function hasBrowserTaskNeedsHumanValue(value: unknown): boolean {
  const record = toRecord(value);
  if (!record) {
    return false;
  }
  const browserTask = toRecord(record.browserTask);
  if (browserTask?.needsHuman === true) {
    return true;
  }
  const cancellation = toRecord(record.cancellation);
  if (
    typeof cancellation?.status === "string" &&
    [
      "awaiting_confirmation",
      "needs_login",
      "needs_mfa",
      "needs_user_choice",
      "retention_offer",
      "phone_only",
      "chat_only",
      "blocked",
    ].includes(cancellation.status)
  ) {
    return true;
  }
  const session = toRecord(record.session);
  return session?.status === "awaiting_confirmation";
}

function actionArtifactsPresent(
  action: ScenarioContext["actionsCalled"][number],
): boolean {
  const result = action.result;
  if (!result) {
    return false;
  }
  if (
    typeof result.screenshot === "string" ||
    typeof result.frontendScreenshot === "string" ||
    typeof result.path === "string"
  ) {
    return true;
  }
  const raw = toRecord(result.raw);
  const data = toRecord(result.data);
  const browserTask = toRecord(data?.browserTask);
  const nestedArtifacts = Array.isArray(browserTask?.artifacts)
    ? browserTask.artifacts
    : Array.isArray(data?.artifacts)
      ? data.artifacts
      : null;
  return (
    Array.isArray(raw?.attachments) ||
    (Array.isArray(nestedArtifacts) && nestedArtifacts.length > 0)
  );
}

function actionBlob(action: ScenarioContext["actionsCalled"][number]): string {
  const parts = [action.actionName];
  if (action.parameters) {
    parts.push(JSON.stringify(action.parameters));
  }
  if (action.result?.data) {
    parts.push(JSON.stringify(action.result.data));
  }
  if (action.result?.values) {
    parts.push(JSON.stringify(action.result.values));
  }
  if (action.result?.text) {
    parts.push(action.result.text);
  }
  if (action.result?.message) {
    parts.push(action.result.message);
  }
  if (action.error?.message) {
    parts.push(action.error.message);
  }
  return parts.join(" ").toLowerCase();
}

function actionCallSummary(
  action: ScenarioContext["actionsCalled"][number],
): string {
  const result = action.result
    ? {
        success: action.result.success,
        text: action.result.text,
        message: action.result.message,
        data: action.result.data,
        values: action.result.values,
        raw:
          action.result.text === undefined &&
          action.result.message === undefined &&
          action.result.data === undefined &&
          action.result.values === undefined
            ? action.result.raw
            : undefined,
      }
    : undefined;
  return JSON.stringify({
    actionName: action.actionName,
    parameters: action.parameters,
    result,
    error: action.error?.message,
  }).slice(0, 500);
}

type TrustedObservationCheck = {
  type:
    | "durableApprovalObserved"
    | "durableDraftObserved"
    | "providerEffectObserved"
    | "providerNoEffectObserved"
    | "scheduledTaskObserved";
  observerId?: string | string[];
  provider?: string | string[];
  accountId?: string | string[];
  operation?: string | string[];
  resourceId?: string | string[];
  state?: string | string[];
  minCount?: number;
  intervalCoversScenario?: boolean;
};

const TRUSTED_OBSERVATION_KIND_BY_CHECK: Record<
  TrustedObservationCheck["type"],
  ScenarioEvidenceObservation["kind"]
> = {
  durableApprovalObserved: "durable-approval",
  durableDraftObserved: "durable-draft",
  providerEffectObserved: "provider-effect",
  providerNoEffectObserved: "provider-no-effect",
  scheduledTaskObserved: "scheduled-task",
};

function sha256Identity(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function matchesStringFilter(
  actual: string | undefined,
  expected: string | string[] | undefined,
): boolean {
  return (
    expected === undefined ||
    (typeof actual === "string" && toArray(expected).includes(actual))
  );
}

function observationProvider(observation: ScenarioEvidenceObservation): string {
  return "provider" in observation
    ? observation.provider
    : observation.source.system;
}

function observationOperation(
  observation: ScenarioEvidenceObservation,
): string | undefined {
  if ("operation" in observation) {
    return observation.operation;
  }
  if (observation.kind === "durable-approval") {
    return observation.actionName;
  }
  return undefined;
}

function observationState(
  observation: ScenarioEvidenceObservation,
): string | undefined {
  return "state" in observation ? observation.state : undefined;
}

function observationAccountHashes(
  observation: ScenarioEvidenceObservation,
): string[] {
  const hashes = [
    observation.source.accountRefSha256,
    "accountRefSha256" in observation
      ? observation.accountRefSha256
      : undefined,
  ];
  return hashes.filter((value): value is string => typeof value === "string");
}

function observationResourceHashes(
  observation: ScenarioEvidenceObservation,
): string[] {
  const hashes: Array<string | undefined> = [observation.source.recordIdSha256];
  if (observation.kind === "durable-approval") {
    hashes.push(observation.approvalIdSha256);
  } else if (observation.kind === "durable-draft") {
    hashes.push(observation.draftIdSha256);
  } else if (observation.kind === "provider-effect") {
    hashes.push(observation.providerReceiptIdSha256);
  } else if (observation.kind === "provider-no-effect") {
    hashes.push(observation.scopeSha256);
  } else {
    hashes.push(observation.taskIdSha256);
  }
  return hashes.filter((value): value is string => typeof value === "string");
}

function matchesHashedFilter(
  actualHashes: readonly string[],
  expected: string | string[] | undefined,
): boolean {
  if (expected === undefined) {
    return true;
  }
  return toArray(expected).some((value) =>
    actualHashes.includes(sha256Identity(value)),
  );
}

function observationCoversScenario(
  observation: ScenarioEvidenceObservation,
  startedAtIso: string | undefined,
  endedAtIso: string | undefined,
): boolean {
  if (
    observation.kind !== "provider-no-effect" ||
    !startedAtIso ||
    !endedAtIso
  ) {
    return false;
  }
  return (
    Date.parse(observation.observationStartedAtIso) <=
      Date.parse(startedAtIso) &&
    Date.parse(observation.observationEndedAtIso) >= Date.parse(endedAtIso)
  );
}

function runTrustedObservationCheck(
  check: TrustedObservationCheck,
  handlerCtx: FinalCheckHandlerContext,
): FinalCheckOutcome {
  const evidence = handlerCtx.trustedEvidence;
  if (evidence?.executionProfile !== "provider-qualified") {
    return {
      status: "skipped",
      detail:
        "trusted observer evidence is unavailable; action results and model prose are not accepted as substitutes",
    };
  }
  const expectedKind = TRUSTED_OBSERVATION_KIND_BY_CHECK[check.type];
  const matches = evidence.observations.filter((observation) => {
    if (observation.kind !== expectedKind) {
      return false;
    }
    if (!matchesStringFilter(observation.observerId, check.observerId)) {
      return false;
    }
    if (
      !matchesStringFilter(observationProvider(observation), check.provider)
    ) {
      return false;
    }
    if (
      !matchesStringFilter(observationOperation(observation), check.operation)
    ) {
      return false;
    }
    if (!matchesStringFilter(observationState(observation), check.state)) {
      return false;
    }
    if (
      !matchesHashedFilter(
        observationAccountHashes(observation),
        check.accountId,
      )
    ) {
      return false;
    }
    if (
      !matchesHashedFilter(
        observationResourceHashes(observation),
        check.resourceId,
      )
    ) {
      return false;
    }
    return (
      check.type !== "providerNoEffectObserved" ||
      check.intervalCoversScenario === false ||
      observationCoversScenario(
        observation,
        handlerCtx.scenarioStartedAtIso,
        handlerCtx.scenarioEndedAtIso,
      )
    );
  });
  const minimum = Math.max(1, check.minCount ?? 1);
  return matches.length >= minimum
    ? {
        status: "passed",
        detail: `${matches.length} independently observed ${expectedKind} record(s) matched`,
      }
    : {
        status: "failed",
        detail: `expected at least ${minimum} independently observed ${expectedKind} record(s), saw ${matches.length}`,
      };
}

// ---------------------------------------------------------------------------
// Built-in handlers
// ---------------------------------------------------------------------------

for (const type of Object.keys(
  TRUSTED_OBSERVATION_KIND_BY_CHECK,
) as TrustedObservationCheck["type"][]) {
  registerFinalCheckHandler(type, (check, handlerCtx) =>
    runTrustedObservationCheck(
      check as unknown as TrustedObservationCheck,
      handlerCtx,
    ),
  );
}

registerFinalCheckHandler("custom", async (check, { runtime, ctx }) => {
  const { predicate } = check as { predicate?: unknown };
  if (typeof predicate !== "function") {
    return { status: "failed", detail: "custom check missing predicate" };
  }
  const scenarioCtx: ScenarioContext = {
    ...ctx,
    runtime,
  };
  const result = await (predicate as (c: ScenarioContext) => unknown)(
    scenarioCtx,
  );
  if (result === undefined || result === null) {
    return { status: "passed", detail: "predicate returned undefined" };
  }
  return { status: "failed", detail: String(result) };
});

registerFinalCheckHandler("actionCalled", (check, { ctx }) => {
  const { actionName, status, minCount } = check as {
    actionName: string;
    status?: string;
    minCount?: number;
  };
  const calls = ctx.actionsCalled.filter(
    (a) => a.actionName === actionName && !isSynthesizedReply(a),
  );
  const min = typeof minCount === "number" ? minCount : 1;
  if (status === "success") {
    const successfulCalls = calls.filter((c) => c.result?.success === true);
    if (successfulCalls.length < min) {
      const actual = calls.map(actionCallSummary).join(" | ") || "(none)";
      return {
        status: "failed",
        detail: `actionCalled: expected ${min} successful ${actionName} call(s) with result.success=true, saw ${successfulCalls.length}. Calls: ${actual}`,
      };
    }
    return {
      status: "passed",
      detail: `${actionName} succeeded ${successfulCalls.length}x (${calls.length} total call(s))`,
    };
  }
  if (calls.length < min) {
    return {
      status: "failed",
      detail: `expected ${min} call(s) to ${actionName}, saw ${calls.length}. Called: ${ctx.actionsCalled.map((a) => a.actionName).join(",") || "(none)"}`,
    };
  }
  return { status: "passed", detail: `${actionName} called ${calls.length}x` };
});

registerFinalCheckHandler("selectedAction", (check, { ctx }) => {
  const { actionName } = check as { actionName: string | string[] };
  const accepted = toArray(actionName);
  const match = ctx.actionsCalled.find(
    (a) => accepted.includes(a.actionName) && !isSynthesizedReply(a),
  );
  if (!match) {
    return {
      status: "failed",
      detail: `no selected action in [${accepted.join(",")}]. Called: ${ctx.actionsCalled.map((a) => a.actionName).join(",") || "(none)"}`,
    };
  }
  return { status: "passed", detail: `selected ${match.actionName}` };
});

registerFinalCheckHandler("selectedActionArguments", (check, { ctx }) => {
  const { actionName, includesAny, includesAll } = check as {
    actionName: string | string[];
    includesAny?: Array<string | RegExp>;
    includesAll?: Array<string | RegExp>;
  };
  const accepted = toArray(actionName);
  const matched = ctx.actionsCalled.filter(
    (a) => accepted.includes(a.actionName) && !isSynthesizedReply(a),
  );
  const actualCalls =
    ctx.actionsCalled.map((a) => a.actionName).join(",") || "(none)";
  if (matched.length === 0) {
    return {
      status: "failed",
      detail: `selectedActionArguments: expected action in [${accepted.join(",")}], saw actions [${actualCalls}]`,
    };
  }
  const blob = matched
    .map((m) => {
      const parts = [m.actionName];
      if (m.parameters) parts.push(JSON.stringify(m.parameters));
      if (m.result?.text) parts.push(m.result.text);
      return parts.join(" ");
    })
    .join(" | ");
  if (includesAll?.length) {
    for (const pattern of includesAll) {
      if (!matchesPattern(blob, pattern)) {
        return {
          status: "failed",
          detail: `selectedActionArguments: expected arguments to include ${String(pattern)}, saw ${JSON.stringify(blob.slice(0, 500))}`,
        };
      }
    }
  }
  if (includesAny?.length) {
    const ok = includesAny.some((p) => matchesPattern(blob, p));
    if (!ok) {
      return {
        status: "failed",
        detail: `selectedActionArguments: expected arguments to include any of [${includesAny.map(String).join(",")}], saw ${JSON.stringify(blob.slice(0, 500))}`,
      };
    }
  }
  return { status: "passed", detail: "action arguments match" };
});

registerFinalCheckHandler(
  "modelCallOccurred",
  async (check, { runtime, ctx }) => {
    const {
      purpose,
      includesAny,
      includesAll,
      minCount,
      scenarioId: explicitScenarioId,
    } = check as {
      purpose?: string | string[];
      includesAny?: Array<string | RegExp>;
      includesAll?: Array<string | RegExp>;
      minCount?: number;
      scenarioId?: string;
    };
    const acceptedPurposes = toArray(purpose);
    const requiredCount =
      typeof minCount === "number" && minCount > 0 ? Math.floor(minCount) : 1;
    const scenarioId = explicitScenarioId ?? ctx.scenarioId;
    const service = resolveTrajectoryService(runtime);
    if (!service) {
      return {
        status: "failed",
        detail:
          "modelCallOccurred: trajectory service unavailable; cannot prove any model call fired",
      };
    }

    const { matchingCalls, observedPurposes } = await waitForMatchingModelCalls(
      service,
      {
        acceptedPurposes,
        requiredCount,
        ...(includesAny ? { includesAny } : {}),
        ...(includesAll ? { includesAll } : {}),
        ...(scenarioId ? { scenarioId } : {}),
      },
    );

    if (matchingCalls.length < requiredCount) {
      const observed =
        [...observedPurposes].sort().join(",") || "(no model-call purposes)";
      return {
        status: "failed",
        detail: `modelCallOccurred: expected ${requiredCount} matching model call(s)${
          acceptedPurposes.length > 0
            ? ` with purpose [${acceptedPurposes.join(",")}]`
            : ""
        }, saw ${matchingCalls.length}. Observed purposes: ${observed}`,
      };
    }

    return {
      status: "passed",
      detail: `modelCallOccurred: matched ${matchingCalls.length} model call(s)${
        acceptedPurposes.length > 0
          ? ` with purpose [${acceptedPurposes.join(",")}]`
          : ""
      }`,
    };
  },
);

registerFinalCheckHandler("memoryWriteOccurred", (check, { ctx }) => {
  const { table, minCount } = check as {
    table: string | string[];
    minCount?: number;
  };
  const tables = toArray(table);
  const writes = ctx.memoryWrites ?? [];
  const matched = writes.filter((w) =>
    tables.length === 0 ? true : tables.includes(w.table),
  );
  const min = typeof minCount === "number" ? minCount : 1;
  if (matched.length < min) {
    return {
      status: "failed",
      detail: `expected ${min} write(s) to [${tables.join(",")}]; saw ${matched.length} of ${writes.length} total.`,
    };
  }
  return {
    status: "passed",
    detail: `${matched.length} write(s) to [${tables.join(",")}]`,
  };
});

registerFinalCheckHandler("memoryExists", (check, { ctx }) => {
  const { table, content, minCount, expected } = check as {
    table?: string | string[];
    content?: unknown;
    minCount?: number;
    expected?: boolean;
  };
  const tables = table === undefined ? [] : toArray(table);
  const writes = ctx.memoryWrites ?? [];
  const matched = writes.filter((write) => {
    if (tables.length > 0 && !tables.includes(write.table)) {
      return false;
    }
    if (content === undefined) {
      return true;
    }
    return matchesContentMatcher(write.content, content);
  });
  const wantPresent = expected ?? true;
  const wantCount = typeof minCount === "number" ? minCount : 1;
  if (wantPresent) {
    if (matched.length < wantCount) {
      return {
        status: "failed",
        detail: `expected ${wantCount} matching memory write(s), saw ${matched.length} of ${writes.length} total`,
      };
    }
    return {
      status: "passed",
      detail: `${matched.length} matching memory write(s)`,
    };
  }
  if (matched.length > 0) {
    return {
      status: "failed",
      detail: `expected no matching memory write, saw ${matched.length}`,
    };
  }
  return {
    status: "passed",
    detail: "no matching memory write observed",
  };
});

registerFinalCheckHandler("goalCountDelta", (check, { ctx }) => {
  const {
    title,
    titleAliases,
    delta,
    expectedStatus,
    expectedReviewState,
    expectedGroundingState,
    requireDescription,
    requireSuccessCriteria,
    requireSupportStrategy,
  } = check as {
    title: string;
    titleAliases?: string[];
    delta?: number;
    expectedStatus?: string;
    expectedReviewState?: string;
    expectedGroundingState?: string;
    requireDescription?: boolean;
    requireSuccessCriteria?: boolean;
    requireSupportStrategy?: boolean;
  };
  const acceptedTitles = [title, ...(titleAliases ?? [])].filter(
    (entry) => typeof entry === "string" && entry.trim().length > 0,
  );
  const goalRecords = ctx.actionsCalled
    .filter(
      (action) =>
        action.result?.success === true && !isSynthesizedReply(action),
    )
    .flatMap((action) => {
      const fromData = goalRecordFromActionResult(action.result?.data);
      const fromRaw = goalRecordFromActionResult(action.result?.raw);
      return [fromData, fromRaw].filter(
        (record): record is Record<string, unknown> => Boolean(record),
      );
    });
  const matched = goalRecords.filter((goal) => {
    const actualTitle = String(goal.title ?? "");
    if (
      !acceptedTitles.some((candidate) =>
        textMatchesLoose(actualTitle, candidate),
      )
    ) {
      return false;
    }
    if (expectedStatus !== undefined && goal.status !== expectedStatus) {
      return false;
    }
    if (
      expectedReviewState !== undefined &&
      goal.reviewState !== expectedReviewState
    ) {
      return false;
    }
    const actualGroundingState =
      readPath(goal, "metadata.goalGrounding.groundingState") ??
      readPath(goal, "metadata.groundingState") ??
      goal.groundingState;
    if (
      expectedGroundingState !== undefined &&
      actualGroundingState !== expectedGroundingState
    ) {
      return false;
    }
    if (
      requireDescription === true &&
      String(goal.description ?? "").trim().length === 0
    ) {
      return false;
    }
    if (
      requireSuccessCriteria === true &&
      !recordHasEntries(goal.successCriteria)
    ) {
      return false;
    }
    if (
      requireSupportStrategy === true &&
      !recordHasEntries(goal.supportStrategy)
    ) {
      return false;
    }
    return true;
  });
  const expectedDelta = typeof delta === "number" ? delta : 1;
  if (expectedDelta <= 0) {
    return matched.length === 0
      ? { status: "passed", detail: "no matching goal records observed" }
      : {
          status: "failed",
          detail: `expected no matching goal records, saw ${matched.length}`,
        };
  }
  if (matched.length < expectedDelta) {
    const titles =
      goalRecords.map((goal) => String(goal.title ?? "")).join(", ") ||
      "(none)";
    return {
      status: "failed",
      detail: `expected ${expectedDelta} matching goal record(s), saw ${matched.length}. Goal titles: ${titles}`,
    };
  }
  return {
    status: "passed",
    detail: `${matched.length} matching goal record(s)`,
  };
});

registerFinalCheckHandler(
  "definitionCountDelta",
  async (check, { runtime }) => {
    const definitionCheck = check as DefinitionCountCheck;
    if (
      typeof definitionCheck.title !== "string" ||
      definitionCheck.title.trim().length === 0
    ) {
      return {
        status: "failed",
        detail: "definitionCountDelta requires a non-empty title",
      };
    }
    const service = await createLifeOpsService(runtime);
    if (!isDefinitionListingService(service)) {
      return {
        status: "failed",
        detail: "LifeOpsService does not expose listDefinitions()",
      };
    }
    const records = (await service.listDefinitions())
      .map(definitionRecordFromValue)
      .filter((record): record is DefinitionRecordLike => record !== null);
    const titleMatches = records.filter((record) =>
      definitionTitleMatches(record.definition, definitionCheck),
    );
    const matched = titleMatches.filter(
      (record) =>
        definitionMismatchReasons(record, definitionCheck).length === 0,
    );
    const delta =
      typeof definitionCheck.delta === "number" ? definitionCheck.delta : 1;
    // Pass details carry the queried store rows so the report itself is the
    // domain-artifact receipt: a delta<=0 pass shows everything that IS stored
    // (proving the forbidden item is absent), a delta>0 pass shows the matched
    // rows' cadence/due/reminder-plan fields for hand inspection.
    if (delta <= 0) {
      if (matched.length === 0) {
        const storedReceipts =
          records.map((record) => definitionReceipt(record)).join(" | ") ||
          "(store empty)";
        return {
          status: "passed",
          detail: `no matching definition for "${definitionCheck.title}" among ${records.length} stored definition(s): ${storedReceipts}`,
        };
      }
      return {
        status: "failed",
        detail: `expected no matching definition for "${definitionCheck.title}", saw ${matched.length}`,
      };
    }
    if (matched.length >= delta) {
      const matchedReceipts = matched
        .map((record) => definitionReceipt(record))
        .join(" | ");
      return {
        status: "passed",
        detail: `${matched.length} matching definition(s) for "${definitionCheck.title}" — stored: ${matchedReceipts}`,
      };
    }
    const mismatchDetails = titleMatches
      .map((record) => {
        const title = String(record.definition.title ?? "(untitled)");
        const reasons = definitionMismatchReasons(record, definitionCheck);
        return `${title}: ${reasons.join("; ") || "matched"}`;
      })
      .join(" | ");
    const storedTitles =
      records
        .map((record) => String(record.definition.title ?? "(untitled)"))
        .join(", ") || "(none)";
    return {
      status: "failed",
      detail:
        titleMatches.length === 0
          ? `expected ${delta} matching definition(s) for "${definitionCheck.title}", saw none among ${records.length} definition(s). Stored definition titles: ${storedTitles}`
          : `expected ${delta} matching definition(s) for "${definitionCheck.title}", saw ${matched.length}. Candidate mismatches: ${mismatchDetails}`,
    };
  },
);

registerFinalCheckHandler("approvalRequestExists", (check, { ctx }) => {
  if (ctx.approvalRequests === undefined) {
    return {
      status: "skipped",
      detail: "dependency missing: no approval queue service registered",
    };
  }
  const { expected, actionName, state } = check as {
    expected?: boolean;
    actionName?: string | string[];
    state?: string | string[];
  };
  const filtered = ctx.approvalRequests.filter((request) => {
    if (!matchesActionName(request.actionName, actionName)) {
      return false;
    }
    if (state === undefined) {
      return true;
    }
    return toArray(state).includes(request.state);
  });
  const want = expected ?? true;
  const any = filtered.length > 0;
  if (any === want) {
    return {
      status: "passed",
      detail: `${filtered.length} matching approval request(s)`,
    };
  }
  if (!any) {
    return {
      status: "failed",
      detail:
        "approval queue registered but no matching requests were captured",
    };
  }
  return {
    status: "failed",
    detail: `expected approvalRequestExists=${want}, saw ${filtered.length} matching request(s)`,
  };
});

registerFinalCheckHandler("approvalStateTransition", (check, { ctx }) => {
  const { from, to, actionName, turn } = check as {
    from: string;
    to: string;
    actionName?: string | string[];
    turn?: string | string[];
  };
  const transitions =
    turn === undefined
      ? (ctx.stateTransitions ?? [])
      : selectedTurnExecutions(ctx, turn).flatMap(
          (execution) => execution.stateTransitions ?? [],
        );
  const matched = transitions.filter((transition) => {
    if (transition.subject !== "approval") {
      return false;
    }
    if (transition.from !== from || transition.to !== to) {
      return false;
    }
    return matchesActionName(transition.actionName ?? "", actionName);
  });
  if (matched.length === 0) {
    return {
      status: "failed",
      detail: `expected approval transition ${from}->${to}; saw ${(ctx.stateTransitions ?? []).length} transition(s)`,
    };
  }
  return {
    status: "passed",
    detail: `${matched.length} matching approval transition(s)`,
  };
});

registerFinalCheckHandler("pushSent", (check, { ctx }) => {
  if (ctx.connectorDispatches === undefined) {
    return {
      status: "skipped",
      detail: "dependency missing: no connector dispatcher registered",
    };
  }
  const { channel } = check as { channel: string | string[] };
  const channels = toArray(channel);
  const hit = ctx.connectorDispatches.filter(
    (d) => isBindingConnectorDispatch(d) && channels.includes(d.channel),
  );
  if (hit.length === 0) {
    return {
      status: "failed",
      detail: `no push sent on [${channels.join(",")}]`,
    };
  }
  return { status: "passed", detail: `${hit.length} push(es)` };
});

registerFinalCheckHandler("pushEscalationOrder", (check, { ctx }) => {
  const { channelOrder } = check as { channelOrder: string[] };
  const seen = (ctx.connectorDispatches ?? [])
    .filter(isBindingConnectorDispatch)
    .map((dispatch) => dispatch.channel);
  let cursor = 0;
  for (const channel of channelOrder) {
    const index = seen.indexOf(channel, cursor);
    if (index === -1) {
      return {
        status: "failed",
        detail: `expected push escalation order [${channelOrder.join(",")}], saw [${seen.join(",")}]`,
      };
    }
    cursor = index + 1;
  }
  return {
    status: "passed",
    detail: `push escalation order matched [${channelOrder.join(",")}]`,
  };
});

registerFinalCheckHandler("pushAcknowledgedSync", (check, { ctx }) => {
  const { expected } = check as { expected?: boolean };
  const any = ctx.actionsCalled.some((action) => {
    const blob = actionBlob(action);
    return /acknowledge/.test(blob) && /sync/.test(blob);
  });
  const want = expected ?? true;
  if (any === want) {
    return { status: "passed", detail: `pushAcknowledgedSync=${want}` };
  }
  return {
    status: "failed",
    detail: `expected pushAcknowledgedSync=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("clarificationRequested", (check, { ctx }) => {
  const { expected } = check as { expected?: boolean };
  const expectedValue = expected ?? true;
  const anyClarify = ctx.actionsCalled.some(
    (a) =>
      /clarif/i.test(a.actionName) ||
      (typeof a.result?.text === "string" && /clarif/i.test(a.result.text)),
  );
  if (anyClarify === expectedValue) {
    return {
      status: "passed",
      detail: `clarification ${expectedValue ? "requested" : "absent"}`,
    };
  }
  return {
    status: "failed",
    detail: `expected clarificationRequested=${expectedValue}, saw ${anyClarify}`,
  };
});

registerFinalCheckHandler("interventionRequestExists", (check, { ctx }) => {
  const { expected } = check as { expected?: boolean };
  const want = expected ?? true;
  const any = (ctx.stateTransitions ?? []).some(
    (t) => t.subject === "intervention",
  );
  if (any === want) {
    return {
      status: "passed",
      detail: `intervention=${want}`,
    };
  }
  return {
    status: "failed",
    detail: `expected interventionRequestExists=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("noSideEffectOnReject", (check, { ctx }) => {
  const { actionName } = check as { actionName: string | string[] };
  const matchingActions = ctx.actionsCalled.filter((action) =>
    matchesActionName(action.actionName, actionName),
  );
  const rejected = matchingActions.some((action) => {
    const params = toRecord(action.parameters);
    return params?.confirmed === false;
  });
  if (!rejected) {
    return {
      status: "failed",
      detail: `no rejected action found for [${toArray(actionName).join(",")}]`,
    };
  }
  const completed = matchingActions.some(
    (action) =>
      hasBrowserTaskCompletedValue(action.result?.data) ||
      hasBrowserTaskCompletedValue(action.result?.raw),
  );
  const artifacts = matchingActions.some((action) =>
    actionArtifactsPresent(action),
  );
  if (completed || artifacts) {
    return {
      status: "failed",
      detail: "reject path still produced a completion or artifact side effect",
    };
  }
  return {
    status: "passed",
    detail: "reject path produced no completion or artifact side effects",
  };
});

registerFinalCheckHandler("browserTaskCompleted", (check, { ctx }) => {
  const { expected } = check as { expected?: boolean };
  const any =
    ctx.actionsCalled.some(
      (action) =>
        hasBrowserTaskCompletedValue(action.result?.data) ||
        hasBrowserTaskCompletedValue(action.result?.raw),
    ) ||
    (ctx.stateTransitions ?? []).some(
      (transition) =>
        transition.subject === "browser_task" && transition.to === "completed",
    );
  const want = expected ?? true;
  if (any === want) {
    return {
      status: "passed",
      detail: `browserTaskCompleted=${want}`,
    };
  }
  return {
    status: "failed",
    detail: `expected browserTaskCompleted=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("browserTaskNeedsHuman", (check, { ctx }) => {
  const { expected } = check as { expected?: boolean };
  const any =
    ctx.actionsCalled.some(
      (action) =>
        hasBrowserTaskNeedsHumanValue(action.result?.data) ||
        hasBrowserTaskNeedsHumanValue(action.result?.raw),
    ) ||
    (ctx.stateTransitions ?? []).some(
      (transition) =>
        transition.subject === "browser_task" &&
        transition.to === "needs_human",
    );
  const want = expected ?? true;
  if (any === want) {
    return {
      status: "passed",
      detail: `browserTaskNeedsHuman=${want}`,
    };
  }
  return {
    status: "failed",
    detail: `expected browserTaskNeedsHuman=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("uploadedAssetExists", (check, { ctx }) => {
  const { expected } = check as { expected?: boolean };
  const any =
    (ctx.artifacts ?? []).length > 0 ||
    ctx.actionsCalled.some((action) => actionArtifactsPresent(action));
  const want = expected ?? true;
  if (any === want) {
    return {
      status: "passed",
      detail: `uploadedAssetExists=${want}`,
    };
  }
  return {
    status: "failed",
    detail: `expected uploadedAssetExists=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("draftExists", (check, { ctx }) => {
  const { channel, expected } = check as {
    channel?: string | string[];
    expected?: boolean;
  };
  const any = ctx.actionsCalled.some((action) => {
    const data = actionResultData(action);
    if (!data) {
      return false;
    }
    if (data.gmailDraft && matchesChannel("gmail", channel)) {
      return true;
    }
    return (
      data.draft === true &&
      matchesChannel(data.channel as string | undefined, channel)
    );
  });
  const want = expected ?? true;
  if (any === want) {
    return {
      status: "passed",
      detail: `draftExists=${want}`,
    };
  }
  return {
    status: "failed",
    detail: `expected draftExists=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("messageDelivered", (check, { ctx }) => {
  const { channel, expected, turn } = check as {
    channel?: string | string[];
    expected?: boolean;
    turn?: string | string[];
  };
  const dispatchDelivered = connectorDispatchesForTurn(ctx, turn).some(
    (dispatch) =>
      isBindingConnectorDispatch(dispatch) &&
      dispatch.delivered === true &&
      matchesChannel(dispatch.channel, channel),
  );
  const any = dispatchDelivered;
  const want = expected ?? true;
  if (any === want) {
    return {
      status: "passed",
      detail: `messageDelivered=${want}`,
    };
  }
  return {
    status: "failed",
    detail: `expected messageDelivered=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("noSideEffects", (check, { ctx }) => {
  const { turn, allowApprovalRequests } = check as {
    turn?: string | string[];
    allowApprovalRequests?: boolean;
  };
  const selectedTurns =
    turn === undefined ? undefined : selectedTurnExecutions(ctx, turn);
  const dispatches = (
    selectedTurns
      ? selectedTurns.flatMap(
          (execution) => execution.connectorDispatches ?? [],
        )
      : (ctx.connectorDispatches ?? [])
  ).filter(isBindingConnectorDispatch);
  const transitions = selectedTurns
    ? selectedTurns.flatMap((execution) => execution.stateTransitions ?? [])
    : (ctx.stateTransitions ?? []);
  const artifacts = selectedTurns
    ? selectedTurns.flatMap((execution) => execution.artifacts ?? [])
    : (ctx.artifacts ?? []);
  const approvals = selectedTurns
    ? selectedTurns.flatMap((execution) => execution.approvalRequests ?? [])
    : (ctx.approvalRequests ?? []);

  const failures: string[] = [];
  if (dispatches.length > 0) failures.push(`${dispatches.length} dispatch(es)`);
  if (transitions.length > 0)
    failures.push(`${transitions.length} state transition(s)`);
  if (artifacts.length > 0) failures.push(`${artifacts.length} artifact(s)`);
  if (!allowApprovalRequests && approvals.length > 0)
    failures.push(`${approvals.length} approval request(s)`);

  if (failures.length > 0) {
    return {
      status: "failed",
      detail: `expected no binding side effects${turn === undefined ? "" : ` on turn(s) [${toArray(turn).join(",")}]`}; saw ${failures.join(", ")}`,
    };
  }
  return {
    status: "passed",
    detail: `no binding side effects${turn === undefined ? "" : ` on turn(s) [${toArray(turn).join(",")}]`}`,
  };
});

registerFinalCheckHandler("connectorDispatchOccurred", (check, { ctx }) => {
  const {
    channel,
    actionName,
    minCount,
    maxCount,
    expected,
    delivered,
    status,
    turn,
    idempotencyKey,
    providerMessageId,
  } = check as {
    channel: string | string[];
    actionName?: string | string[];
    minCount?: number;
    maxCount?: number;
    expected?: boolean;
    delivered?: boolean;
    status?: string | string[];
    turn?: string | string[];
    idempotencyKey?: string;
    providerMessageId?: string;
  };
  const matching = connectorDispatchesForTurn(ctx, turn).filter(
    (dispatch) =>
      isBindingConnectorDispatch(dispatch) &&
      matchesChannel(dispatch.channel, channel) &&
      matchesActionName(dispatch.actionName ?? "", actionName) &&
      (delivered === undefined || dispatch.delivered === delivered) &&
      (status === undefined ||
        toArray(status).includes(dispatch.status ?? "")) &&
      (idempotencyKey === undefined ||
        dispatch.idempotencyKey === idempotencyKey) &&
      (providerMessageId === undefined ||
        dispatch.providerMessageIds?.includes(providerMessageId) === true),
  );
  const total = matching.length;
  const want = expected === false ? 0 : (minCount ?? 1);
  const ceiling = expected === false ? 0 : maxCount;
  if (total < want || (ceiling !== undefined && total > ceiling)) {
    return {
      status: "failed",
      detail: `expected ${want}${ceiling !== undefined ? `..${ceiling}` : "+"} binding connector dispatch(es) on [${toArray(channel).join(",")}], saw ${total}`,
    };
  }
  return {
    status: "passed",
    detail: `${total} connector dispatch(es) on [${toArray(channel).join(",")}]`,
  };
});

registerFinalCheckHandler("gmailActionArguments", (check, { ctx }) => {
  const {
    actionName,
    subaction,
    operation,
    fields,
    minCount,
    maxCount,
    expected,
    turn,
    exactArrays,
  } = check as {
    actionName?: string | string[];
    subaction?: string | string[];
    operation?: string | string[];
    fields?: Record<string, unknown>;
    minCount?: number;
    maxCount?: number;
    expected?: boolean;
    turn?: string | string[];
    exactArrays?: boolean;
  };
  const actionNames = actionName ?? ["MESSAGE", "GMAIL_ACTION", "INBOX"];
  const matched = actionsForTurn(ctx, turn).filter((action) => {
    if (!matchesActionName(action.actionName, actionNames)) {
      return false;
    }
    const params = actionParameters(action);
    if (!params) {
      return false;
    }
    if (
      subaction !== undefined &&
      !toArray(subaction).includes(
        String(params.subaction ?? params.action ?? params.operation ?? ""),
      )
    ) {
      return false;
    }
    const actualOperation =
      params.operation ??
      readPath(params, "details.operation") ??
      (params.action === "manage" ? readPath(params, "details.action") : null);
    if (
      operation !== undefined &&
      !toArray(operation).includes(String(actualOperation ?? ""))
    ) {
      return false;
    }
    return matchesExpectedFieldsWithArrayPolicy(
      params,
      fields,
      exactArrays === true,
    );
  });
  const want = expected === false ? 0 : (minCount ?? 1);
  const ceiling = expected === false ? 0 : maxCount;
  if (
    matched.length < want ||
    (ceiling !== undefined && matched.length > ceiling)
  ) {
    return {
      status: "failed",
      detail: `expected ${want}${ceiling !== undefined ? `..${ceiling}` : "+"} Gmail action(s) with structured arguments; saw ${matched.length}`,
    };
  }
  return {
    status: "passed",
    detail: `${matched.length} Gmail action(s) matched structured arguments`,
  };
});

registerFinalCheckHandler("gmailMockRequest", async (check, { ctx }) => {
  const {
    method,
    path,
    body,
    gmail,
    expected,
    minCount,
    maxCount,
    turn,
    exactArrays,
  } = check as {
    method?: string | string[];
    path?: string | string[];
    body?: Record<string, unknown>;
    gmail?: Record<string, unknown>;
    expected?: boolean;
    minCount?: number;
    maxCount?: number;
    turn?: string | string[];
    exactArrays?: boolean;
  };
  const evidence = await resolveGmailMockRequests(ctx, turn);
  if (evidence.requests === undefined) {
    return {
      status: "failed",
      detail: evidence.error ?? "Gmail mock request evidence unavailable",
    };
  }
  const requests = evidence.requests;
  const matched = requests.filter((entry) =>
    gmailRequestMatches(entry, { method, path, body, gmail, exactArrays }),
  );
  const wantPresent = expected ?? true;
  const wantCount = typeof minCount === "number" ? minCount : 1;
  if (wantPresent) {
    if (
      matched.length < wantCount ||
      (maxCount !== undefined && matched.length > maxCount)
    ) {
      return {
        status: "failed",
        detail: `expected ${wantCount}${maxCount !== undefined ? `..${maxCount}` : "+"} Gmail mock request(s), saw ${matched.length} of ${requests.length}`,
      };
    }
    return {
      status: "passed",
      detail: `${matched.length} Gmail mock request(s) matched`,
    };
  }
  if (matched.length > 0) {
    return {
      status: "failed",
      detail: `expected no Gmail mock request match, saw ${matched.length}`,
    };
  }
  return {
    status: "passed",
    detail: "no matching Gmail mock request observed",
  };
});

registerFinalCheckHandler("gmailDraftCreated", async (check, { ctx }) => {
  const { expected, turn } = check as {
    expected?: boolean;
    turn?: string | string[];
  };
  const evidence = await resolveGmailMockRequests(ctx, turn);
  if (evidence.requests === undefined) {
    return {
      status: "failed",
      detail: evidence.error ?? "Gmail mock request evidence unavailable",
    };
  }
  const requests = evidence.requests;
  const ledgerHit = requests.some((entry) =>
    gmailRequestMatches(entry, {
      method: "POST",
      path: "/gmail/v1/users/me/drafts",
    }),
  );
  const actionHit = actionsForTurn(ctx, turn).some((action) =>
    hasGmailDraftData(action),
  );
  const any = ledgerHit || actionHit;
  const want = expected ?? true;
  if (any === want) {
    return { status: "passed", detail: `gmailDraftCreated=${want}` };
  }
  return {
    status: "failed",
    detail: `expected gmailDraftCreated=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("gmailDraftDeleted", async (check) => {
  const { expected } = check as { expected?: boolean };
  const requests = await readGmailMockRequests();
  const any = requests.some(
    (entry) =>
      String(entry.method ?? "").toUpperCase() === "DELETE" &&
      /^\/gmail\/v1\/users\/me\/drafts\/[^/]+$/.test(String(entry.path ?? "")),
  );
  const want = expected ?? true;
  if (any === want) {
    return { status: "passed", detail: `gmailDraftDeleted=${want}` };
  }
  return {
    status: "failed",
    detail: `expected gmailDraftDeleted=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("gmailMessageSent", async (check, { ctx }) => {
  const { expected, turn } = check as {
    expected?: boolean;
    turn?: string | string[];
  };
  const evidence = await resolveGmailMockRequests(ctx, turn);
  if (evidence.requests === undefined) {
    return {
      status: "failed",
      detail: evidence.error ?? "Gmail mock request evidence unavailable",
    };
  }
  const requests = evidence.requests;
  const any = requests.some((entry) =>
    gmailRequestMatches(entry, {
      method: "POST",
      path: gmailSendLedgerPaths(),
    }),
  );
  const want = expected ?? true;
  if (any === want) {
    return { status: "passed", detail: `gmailMessageSent=${want}` };
  }
  return {
    status: "failed",
    detail: `expected gmailMessageSent=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("gmailBatchModify", async (check, { ctx }) => {
  const { expected, body, turn, exactArrays } = check as {
    expected?: boolean;
    body?: Record<string, unknown>;
    turn?: string | string[];
    exactArrays?: boolean;
  };
  const evidence = await resolveGmailMockRequests(ctx, turn);
  if (evidence.requests === undefined) {
    return {
      status: "failed",
      detail: evidence.error ?? "Gmail mock request evidence unavailable",
    };
  }
  const requests = evidence.requests;
  const any = requests.some((entry) =>
    gmailRequestMatches(entry, {
      method: "POST",
      path: "/gmail/v1/users/me/messages/batchModify",
      body,
      exactArrays,
    }),
  );
  const want = expected ?? true;
  if (any === want) {
    return { status: "passed", detail: `gmailBatchModify=${want}` };
  }
  return {
    status: "failed",
    detail: `expected gmailBatchModify=${want}, saw ${any}`,
  };
});

registerFinalCheckHandler("gmailApproval", async (check, { ctx }) => {
  const { state, turn } = check as {
    state: "pending" | "confirmed" | "canceled" | "cancelled";
    turn?: string | string[];
  };
  const selectedActions = actionsForTurn(ctx, turn);
  const selectedApprovals =
    turn === undefined
      ? (ctx.approvalRequests ?? [])
      : selectedTurnExecutions(ctx, turn).flatMap(
          (execution) => execution.approvalRequests ?? [],
        );
  if (state === "pending") {
    const any =
      selectedApprovals.some(
        (request) =>
          matchesActionName(request.actionName, [
            "MESSAGE",
            "GMAIL_ACTION",
            "send_email",
          ]) && request.state === "pending",
      ) ||
      selectedActions.some((action) => {
        const data = actionResultData(action);
        return (
          data?.pendingApproval === true || data?.requiresConfirmation === true
        );
      });
    return any
      ? { status: "passed", detail: "pending Gmail approval observed" }
      : { status: "failed", detail: "no pending Gmail approval observed" };
  }
  if (state === "confirmed") {
    const evidence = await resolveGmailMockRequests(ctx, turn);
    if (evidence.requests === undefined) {
      return {
        status: "failed",
        detail: evidence.error ?? "Gmail mock request evidence unavailable",
      };
    }
    const requests = evidence.requests;
    const sendHit = requests.some((entry) =>
      gmailRequestMatches(entry, {
        method: "POST",
        path: gmailSendLedgerPaths(),
      }),
    );
    const actionHit = selectedActions.some((action) =>
      hasConfirmedGmailSendAction(action),
    );
    return sendHit || actionHit
      ? { status: "passed", detail: "confirmed Gmail send observed" }
      : { status: "failed", detail: "no confirmed Gmail send observed" };
  }
  const canceled = selectedActions.some((action) => {
    const data = actionResultData(action);
    return data?.noop === true && data?.cancelled === true;
  });
  return canceled
    ? { status: "passed", detail: "canceled Gmail approval observed" }
    : { status: "failed", detail: "no canceled Gmail approval observed" };
});

registerFinalCheckHandler("gmailNoRealWrite", () => {
  if (!isLoopbackUrl(process.env.ELIZA_MOCK_GOOGLE_BASE)) {
    return {
      status: "failed",
      detail:
        "ELIZA_MOCK_GOOGLE_BASE is not loopback; Gmail write proof cannot exclude real writes",
    };
  }
  if (process.env.ELIZA_ALLOW_REAL_GMAIL_WRITES === "1") {
    return {
      status: "failed",
      detail: "ELIZA_ALLOW_REAL_GMAIL_WRITES=1 disables no-real-write proof",
    };
  }
  return {
    status: "passed",
    detail: "Gmail writes are constrained to the loopback mock base",
  };
});

registerFinalCheckHandler("workflowDispatchOccurred", (check, { ctx }) => {
  const { workflowId, expected, minCount } = check as {
    workflowId?: string;
    expected?: boolean;
    minCount?: number;
  };
  const matchedActions = ctx.actionsCalled.filter((action) =>
    hasRecursiveObjectMatch(
      action.result?.data ?? action.result?.raw,
      (record) => {
        if (record.kind !== "dispatch_workflow") {
          return false;
        }
        return workflowId === undefined || record.workflowId === workflowId;
      },
    ),
  );
  const matchedWrites = (ctx.memoryWrites ?? []).filter((write) =>
    hasRecursiveObjectMatch(write.content, (record) => {
      if (record.kind !== "dispatch_workflow") {
        return false;
      }
      return workflowId === undefined || record.workflowId === workflowId;
    }),
  );
  const total = matchedActions.length + matchedWrites.length;
  const want = expected ?? true;
  if (!want) {
    return total === 0
      ? { status: "passed", detail: "no workflow dispatch observed" }
      : {
          status: "failed",
          detail: `expected no workflow dispatch, saw ${total}`,
        };
  }
  const min = typeof minCount === "number" ? minCount : 1;
  if (total < min) {
    return {
      status: "failed",
      detail: `expected ${min} workflow dispatch record(s), saw ${total}`,
    };
  }
  return {
    status: "passed",
    detail: `${total} workflow dispatch record(s) observed`,
  };
});

registerFinalCheckHandler(
  "reminderIntensity",
  async (check, { runtime, ctx }) => {
    const { title, titleAliases, expected } = check as {
      title?: string;
      titleAliases?: string[];
      expected?: string;
    };
    if (typeof title !== "string" || title.length === 0) {
      return { status: "failed", detail: "reminderIntensity missing title" };
    }
    if (typeof expected !== "string" || expected.length === 0) {
      return { status: "failed", detail: "reminderIntensity missing expected" };
    }
    const titleCandidates = titleCandidatesForReminderIntensity({
      title,
      titleAliases,
    });
    if (expected === "escalated") {
      const attempts = collectReminderAttempts(
        (ctx.turns ?? []).map((turn) => turn.responseBody),
      );
      const matched = attempts.filter((attempt) =>
        isDeliveredEscalationAttempt(attempt, titleCandidates),
      );
      if (matched.length > 0) {
        return {
          status: "passed",
          detail: `${matched.length} delivered escalation reminder attempt(s) matched [${titleCandidates.join(", ")}]`,
        };
      }
      return {
        status: "failed",
        detail: `no delivered escalation reminder attempts matched [${titleCandidates.join(", ")}]; saw ${attempts.length} reminder attempt(s)`,
      };
    }
    return checkStoredReminderIntensity(runtime, titleCandidates, expected);
  },
);

// judgeRubric is handled inline by the executor so it can reuse the live LLM
// without threading the runtime through the generic handler registry.
registerFinalCheckHandler("judgeRubric", () => ({
  status: "passed",
  detail: "deferred to executor (inline judge pass)",
}));

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function runFinalCheck(
  check: ScenarioFinalCheck,
  handlerCtx: FinalCheckHandlerContext,
): Promise<FinalCheckReport> {
  const type = (check as { type?: string }).type ?? "unknown";
  const name = (check as { name?: string }).name ?? type;
  const handler = HANDLERS.get(type);
  if (!handler) {
    return {
      label: name,
      type,
      status: "failed" satisfies FinalCheckStatus,
      detail: `no handler registered for finalCheck type "${type}"`,
    };
  }
  const strictKeys = FINAL_CHECK_KEYS.get(type);
  if (strictKeys) {
    const unknownKeys = Object.keys(check as Record<string, unknown>).filter(
      (key) => !strictKeys.has(key),
    );
    if (unknownKeys.length > 0) {
      return {
        label: name,
        type,
        status: "failed",
        detail: `unknown field(s) for finalCheck type "${type}": ${unknownKeys.join(", ")}`,
      };
    }
  }
  const outcome = await handler(check, handlerCtx);
  return {
    label: name,
    type,
    status: outcome.status,
    detail: outcome.detail,
  };
}

type ReminderPreferenceService = {
  listDefinitions(): Promise<unknown[]>;
  getReminderPreference(definitionId?: string | null): Promise<unknown>;
};

function isReminderPreferenceService(
  value: unknown,
): value is ReminderPreferenceService {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return (
    "listDefinitions" in value &&
    typeof value.listDefinitions === "function" &&
    "getReminderPreference" in value &&
    typeof value.getReminderPreference === "function"
  );
}

function titleCandidatesForReminderIntensity(check: {
  title: string;
  titleAliases?: string[];
}): string[] {
  return [check.title, ...(check.titleAliases ?? [])];
}

function reminderDefinitionTitle(value: unknown): string | null {
  const record = toRecord(value);
  const definition = toRecord(record?.definition);
  return typeof definition?.title === "string" ? definition.title : null;
}

function reminderDefinitionId(value: unknown): string | null {
  const record = toRecord(value);
  const definition = toRecord(record?.definition);
  return typeof definition?.id === "string" ? definition.id : null;
}

function matchesReminderTitle(value: unknown, candidates: string[]): boolean {
  return (
    typeof value === "string" &&
    candidates.some((candidate) => textMatchesLoose(value, candidate))
  );
}

function collectReminderAttempts(
  value: unknown,
  out: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectReminderAttempts(entry, out);
    }
    return out;
  }
  const record = toRecord(value);
  if (!record) {
    return out;
  }
  if (toRecord(record.deliveryMetadata)) {
    out.push(record);
  }
  for (const entry of Object.values(record)) {
    collectReminderAttempts(entry, out);
  }
  return out;
}

function isDeliveredEscalationAttempt(
  attempt: Record<string, unknown>,
  titleCandidates: string[],
): boolean {
  if (attempt.outcome !== "delivered") {
    return false;
  }
  const deliveryMetadata = toRecord(attempt.deliveryMetadata);
  if (!deliveryMetadata) {
    return false;
  }
  if (!matchesReminderTitle(deliveryMetadata.title, titleCandidates)) {
    return false;
  }
  return (
    deliveryMetadata[REMINDER_LIFECYCLE_METADATA_KEY] === "escalation" ||
    typeof deliveryMetadata[REMINDER_ESCALATION_INDEX_METADATA_KEY] === "number"
  );
}

async function checkStoredReminderIntensity(
  runtime: FinalCheckRuntime,
  titleCandidates: string[],
  expected: string,
): Promise<FinalCheckOutcome> {
  const service = await createLifeOpsService(runtime);
  if (!isReminderPreferenceService(service)) {
    return {
      status: "skipped",
      detail:
        "dependency missing: LifeOpsService does not expose reminder preference methods",
    };
  }
  const definitions = await service.listDefinitions();
  const match = definitions.find((entry) => {
    const title = reminderDefinitionTitle(entry);
    return title !== null && matchesReminderTitle(title, titleCandidates);
  });
  if (!match) {
    return {
      status: "failed",
      detail: `no reminder definition matched [${titleCandidates.join(", ")}]`,
    };
  }
  const definitionId = reminderDefinitionId(match);
  if (!definitionId) {
    return {
      status: "failed",
      detail: "matched reminder definition has no id",
    };
  }
  const preference = toRecord(
    await service.getReminderPreference(definitionId),
  );
  const effective = toRecord(preference?.effective);
  const actual =
    typeof effective?.intensity === "string" ? effective.intensity : undefined;
  if (actual === expected) {
    return {
      status: "passed",
      detail: `reminder "${reminderDefinitionTitle(match) ?? definitionId}" effective intensity=${expected}`,
    };
  }
  return {
    status: "failed",
    detail: `expected reminder "${reminderDefinitionTitle(match) ?? definitionId}" effective intensity=${expected}, saw ${actual ?? "(missing)"}`,
  };
}
