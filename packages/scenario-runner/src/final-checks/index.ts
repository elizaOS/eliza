/**
 * Registry of finalCheck handlers keyed by the discriminator string from
 * `ScenarioFinalCheck.type`. Unknown kinds fail loudly so scenario proof fields
 * cannot be misspelled or silently skipped.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  FINAL_CHECK_KEYS,
  type ScenarioContext,
  type ScenarioFinalCheck,
} from "@elizaos/scenario-runner/schema";
import type { FinalCheckReport, FinalCheckStatus } from "../types.ts";
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
  return value.trim().toLowerCase().replace(/\s+/g, " ");
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
  const { LifeOpsService } = await import(
    "@elizaos/plugin-personal-assistant/lifeops/service"
  );
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
    for (const forbidden of check.forbiddenDueLocalTimes) {
      if (typeof forbidden.hour !== "number") {
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

type GmailMockRequest = {
  environment?: string;
  method?: string;
  path?: string;
  query?: string;
  body?: unknown;
  createdAt?: string;
};

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

function gmailRequestMatches(
  entry: GmailMockRequest,
  filters: {
    method?: string | string[];
    path?: string | string[];
    body?: Record<string, unknown>;
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
  return matchesExpectedFields(entry.body, filters.body);
}

function gmailSendLedgerPaths(): string[] {
  return ["/gmail/v1/users/me/messages/send", "/gmail/v1/users/me/drafts/send"];
}

function hasGmailDraftData(
  action: ScenarioContext["actionsCalled"][number],
): boolean {
  const data = actionResultData(action);
  return Boolean(data?.gmailDraft);
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

// ---------------------------------------------------------------------------
// Built-in handlers
// ---------------------------------------------------------------------------

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
      readPath(goal, "metadata.groundingState") ?? goal.groundingState;
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
    if (delta <= 0) {
      if (matched.length === 0) {
        return {
          status: "passed",
          detail: `no matching definition for "${definitionCheck.title}"`,
        };
      }
      return {
        status: "failed",
        detail: `expected no matching definition for "${definitionCheck.title}", saw ${matched.length}`,
      };
    }
    if (matched.length >= delta) {
      return {
        status: "passed",
        detail: `${matched.length} matching definition(s) for "${definitionCheck.title}"`,
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
  const { from, to, actionName } = check as {
    from: string;
    to: string;
    actionName?: string | string[];
  };
  const matched = (ctx.stateTransitions ?? []).filter((transition) => {
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
  const hit = ctx.connectorDispatches.filter((d) =>
    channels.includes(d.channel),
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
  const seen = (ctx.connectorDispatches ?? []).map(
    (dispatch) => dispatch.channel,
  );
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
  const { channel, expected } = check as {
    channel?: string | string[];
    expected?: boolean;
  };
  const dispatchDelivered = (ctx.connectorDispatches ?? []).some(
    (dispatch) =>
      dispatch.delivered === true && matchesChannel(dispatch.channel, channel),
  );
  const actionDelivered = ctx.actionsCalled.some((action) => {
    const data = actionResultData(action);
    if (!data) {
      return false;
    }
    const status = typeof data.status === "string" ? data.status : "";
    return (
      matchesChannel(data.channel as string | undefined, channel) &&
      ["sent", "delivered", "completed"].includes(status.toLowerCase())
    );
  });
  const any = dispatchDelivered || actionDelivered;
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

registerFinalCheckHandler("connectorDispatchOccurred", (check, { ctx }) => {
  const { channel, actionName, minCount } = check as {
    channel: string | string[];
    actionName?: string | string[];
    minCount?: number;
  };
  const dispatchCount = (ctx.connectorDispatches ?? []).filter((dispatch) =>
    matchesChannel(dispatch.channel, channel),
  ).length;
  const actionFallbackCount = ctx.actionsCalled.filter((action) => {
    if (!matchesActionName(action.actionName, actionName)) {
      return false;
    }
    const data = actionResultData(action);
    if (!data) {
      return false;
    }
    const status = typeof data.status === "string" ? data.status : "";
    return (
      matchesChannel(data.channel as string | undefined, channel) &&
      ["sent", "delivered", "completed"].includes(status.toLowerCase())
    );
  }).length;
  const total = dispatchCount + actionFallbackCount;
  const want = typeof minCount === "number" ? minCount : 1;
  if (total < want) {
    return {
      status: "failed",
      detail: `expected ${want} connector dispatch(es) on [${toArray(channel).join(",")}], saw ${total}`,
    };
  }
  return {
    status: "passed",
    detail: `${total} connector dispatch(es) on [${toArray(channel).join(",")}]`,
  };
});

registerFinalCheckHandler("gmailActionArguments", (check, { ctx }) => {
  const { actionName, subaction, operation, fields, minCount } = check as {
    actionName?: string | string[];
    subaction?: string | string[];
    operation?: string | string[];
    fields?: Record<string, unknown>;
    minCount?: number;
  };
  const actionNames = actionName ?? ["MESSAGE", "GMAIL_ACTION", "INBOX"];
  const matched = ctx.actionsCalled.filter((action) => {
    if (!matchesActionName(action.actionName, actionNames)) {
      return false;
    }
    const params = actionParameters(action);
    if (!params) {
      return false;
    }
    if (
      subaction !== undefined &&
      !toArray(subaction).includes(String(params.subaction ?? ""))
    ) {
      return false;
    }
    const actualOperation =
      params.operation ?? readPath(params, "details.operation");
    if (
      operation !== undefined &&
      !toArray(operation).includes(String(actualOperation ?? ""))
    ) {
      return false;
    }
    return matchesExpectedFields(params, fields);
  });
  const want = typeof minCount === "number" ? minCount : 1;
  if (matched.length < want) {
    return {
      status: "failed",
      detail: `expected ${want} Gmail action(s) with structured arguments; saw ${matched.length}`,
    };
  }
  return {
    status: "passed",
    detail: `${matched.length} Gmail action(s) matched structured arguments`,
  };
});

registerFinalCheckHandler("gmailMockRequest", async (check) => {
  const { method, path, body, expected, minCount } = check as {
    method?: string | string[];
    path?: string | string[];
    body?: Record<string, unknown>;
    expected?: boolean;
    minCount?: number;
  };
  const requests = await readGmailMockRequests();
  const matched = requests.filter((entry) =>
    gmailRequestMatches(entry, { method, path, body }),
  );
  const wantPresent = expected ?? true;
  const wantCount = typeof minCount === "number" ? minCount : 1;
  if (wantPresent) {
    if (matched.length < wantCount) {
      return {
        status: "failed",
        detail: `expected ${wantCount} Gmail mock request(s), saw ${matched.length} of ${requests.length}`,
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
  const { expected } = check as { expected?: boolean };
  const requests = await readGmailMockRequests();
  const ledgerHit = requests.some((entry) =>
    gmailRequestMatches(entry, {
      method: "POST",
      path: "/gmail/v1/users/me/drafts",
    }),
  );
  const actionHit = ctx.actionsCalled.some((action) =>
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

registerFinalCheckHandler("gmailMessageSent", async (check) => {
  const { expected } = check as { expected?: boolean };
  const requests = await readGmailMockRequests();
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

registerFinalCheckHandler("gmailBatchModify", async (check) => {
  const { expected, body } = check as {
    expected?: boolean;
    body?: Record<string, unknown>;
  };
  const requests = await readGmailMockRequests();
  const any = requests.some((entry) =>
    gmailRequestMatches(entry, {
      method: "POST",
      path: "/gmail/v1/users/me/messages/batchModify",
      body,
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
  const { state } = check as {
    state: "pending" | "confirmed" | "canceled" | "cancelled";
  };
  if (state === "pending") {
    const any =
      (ctx.approvalRequests ?? []).some(
        (request) =>
          matchesActionName(request.actionName, [
            "MESSAGE",
            "GMAIL_ACTION",
            "send_email",
          ]) && request.state === "pending",
      ) ||
      ctx.actionsCalled.some((action) => {
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
    const requests = await readGmailMockRequests();
    const sendHit = requests.some((entry) =>
      gmailRequestMatches(entry, {
        method: "POST",
        path: gmailSendLedgerPaths(),
      }),
    );
    const actionHit = ctx.actionsCalled.some((action) =>
      hasConfirmedGmailSendAction(action),
    );
    return sendHit || actionHit
      ? { status: "passed", detail: "confirmed Gmail send observed" }
      : { status: "failed", detail: "no confirmed Gmail send observed" };
  }
  const canceled = ctx.actionsCalled.some((action) => {
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
