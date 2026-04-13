import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createConversation, req } from "../../../../test/helpers/http.ts";
import type {
  LifeOpsDefinitionEntry,
  LifeOpsGoalEntry,
  SelectedLiveProvider,
  StartedLifeOpsLiveRuntime,
} from "./lifeops-live-harness.ts";
import {
  assertNoProviderIssue,
  getReminderPreference,
  listDefinitionEntries,
  listGoalEntries,
  normalizeLiveText,
  postLiveConversationMessage,
  REPO_ROOT,
  resolveDefinitionIdByTitle,
  resolveOccurrenceIdByTitle,
  selectLifeOpsLiveProvider,
  startLifeOpsLiveRuntime,
  waitForTrajectoryCall,
} from "./lifeops-live-harness.ts";
import { judgeTextWithLlm } from "./lifeops-live-judge.ts";

export type ScenarioRoom = {
  id: string;
  source?: string;
  title?: string;
};

export type ScenarioTurn = {
  name: string;
  room?: string;
  source?: string;
  text?: string;
  apiRequest?: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
  };
  apiStatus?: number;
  apiResponseIncludesAll?: string[];
  apiResponseIncludesAny?: string[];
  apiResponseExcludes?: string[];
  responseIncludesAll?: string[];
  responseIncludesAny?: string[];
  responseExcludes?: string[];
  responseJudge?: {
    minimumScore?: number;
    rubric: string;
  };
  plannerIncludesAll?: string[];
  plannerIncludesAny?: string[];
  plannerExcludes?: string[];
  plannerJudge?: {
    minimumScore?: number;
    rubric: string;
  };
  attempts?: number;
  trajectoryTimeoutMs?: number;
  waitForDefinitionTitle?: string;
  waitForDefinitionTitleAliases?: string[];
  waitForGoalTitle?: string;
  waitForGoalTitleAliases?: string[];
};

type DefinitionCountDeltaCheck = {
  type: "definitionCountDelta";
  title: string;
  titleAliases?: string[];
  delta: number;
  cadenceKind?: string;
  requiredWindows?: string[];
  requiredWeekdays?: number[];
  requiredSlots?: Array<{ label?: string; minuteOfDay?: number }>;
  requiredEveryMinutes?: number;
  requiredMaxOccurrencesPerDay?: number;
  requireReminderPlan?: boolean;
  expectedTimeZone?: string;
  websiteAccess?: {
    unlockMode?: string;
    unlockDurationMinutes?: number;
    websites?: string[];
  };
};

type ReminderIntensityCheck = {
  type: "reminderIntensity";
  title: string;
  titleAliases?: string[];
  expected: string;
};

type GoalCountDeltaCheck = {
  type: "goalCountDelta";
  title: string;
  titleAliases?: string[];
  delta: number;
  expectedStatus?: string;
  expectedReviewState?: string;
  requireDescription?: boolean;
  requireSuccessCriteria?: boolean;
  requireSupportStrategy?: boolean;
  expectedGroundingState?: string;
};

export type ScenarioFinalCheck =
  | DefinitionCountDeltaCheck
  | ReminderIntensityCheck
  | GoalCountDeltaCheck;

export type LifeOpsLiveScenario = {
  id: string;
  title: string;
  domain: string;
  description?: string;
  requiresIsolation?: boolean;
  rooms?: ScenarioRoom[];
  turns: ScenarioTurn[];
  finalChecks?: ScenarioFinalCheck[];
};

export type ScenarioTurnReport = {
  conversationId: string;
  name: string;
  plannerResponse?: string;
  responseText: string;
  source: string;
  text: string;
  trajectoryId?: string;
};

export type ScenarioReport = {
  durationMs: number;
  error?: string;
  finalChecks: Array<{
    label: string;
    status: "passed" | "failed";
    detail: string;
  }>;
  id: string;
  providerName: string;
  startedAt: string;
  status: "passed" | "failed";
  title: string;
  turns: ScenarioTurnReport[];
};

export type ScenarioMatrixReport = {
  completedAt: string;
  failedCount: number;
  providerName: string;
  scenarios: ScenarioReport[];
  startedAt: string;
  totalCount: number;
};

const DEFAULT_SCENARIO_DIR = path.join(
  REPO_ROOT,
  "test",
  "lifeops",
  "scenarios",
);
const FINAL_CHECK_TIMEOUT_MS = 20_000;
const FINAL_CHECK_RETRY_MS = 500;
const LIVE_API_TURN_TIMEOUT_MS = 120_000;
const LIVE_ROOM_CREATION_TIMEOUT_MS = 30_000;

export type ScenarioProgressEvent =
  | {
      type: "runtime:ready";
      mode: "isolated" | "shared";
      scenarioId?: string;
    }
  | {
      type: "runtime:start";
      mode: "isolated" | "shared";
      scenarioId?: string;
    }
  | {
      type: "scenario:start";
      scenarioId: string;
      title: string;
    }
  | {
      type: "scenario:complete";
      durationMs: number;
      error?: string;
      scenarioId: string;
      status: "passed" | "failed";
      title: string;
    }
  | {
      type: "turn:start";
      index: number;
      scenarioId: string;
      total: number;
      turnName: string;
    }
  | {
      type: "turn:complete";
      index: number;
      scenarioId: string;
      total: number;
      turnName: string;
    };

function normalizeText(text: string): string {
  return normalizeLiveText(text);
}

function tokenizeComparableText(text: string): string[] {
  return Array.from(text.toLowerCase().matchAll(/[a-z0-9]+/g), (match) =>
    String(match[0]),
  );
}

function includesComparableFragment(text: string, fragment: string): boolean {
  const normalizedText = normalizeText(text);
  const normalizedFragment = normalizeText(fragment);
  if (normalizedText.includes(normalizedFragment)) {
    return true;
  }

  if (/[<>]/.test(fragment)) {
    return false;
  }

  const textTokens = tokenizeComparableText(text);
  const fragmentTokens = tokenizeComparableText(fragment);
  if (textTokens.length === 0 || fragmentTokens.length === 0) {
    return false;
  }

  let fragmentIndex = 0;
  for (const token of textTokens) {
    if (token === fragmentTokens[fragmentIndex]) {
      fragmentIndex += 1;
      if (fragmentIndex >= fragmentTokens.length) {
        return true;
      }
    }
  }

  return false;
}

function assertIncludesAll(
  label: string,
  text: string,
  fragments?: string[],
): void {
  if (!fragments || fragments.length === 0) {
    return;
  }

  const normalized = normalizeText(text);
  for (const fragment of fragments) {
    if (
      !normalized.includes(fragment.toLowerCase()) &&
      !includesComparableFragment(text, fragment)
    ) {
      throw new Error(
        `${label} did not include "${fragment}".\nactual=${text}`,
      );
    }
  }
}

function assertIncludesAny(
  label: string,
  text: string,
  fragments?: string[],
): void {
  if (!fragments || fragments.length === 0) {
    return;
  }

  const normalized = normalizeText(text);
  if (
    !fragments.some(
      (fragment) =>
        normalized.includes(fragment.toLowerCase()) ||
        includesComparableFragment(text, fragment),
    )
  ) {
    throw new Error(
      `${label} did not include any of ${JSON.stringify(fragments)}.\nactual=${text}`,
    );
  }
}

function assertExcludes(
  label: string,
  text: string,
  fragments?: string[],
): void {
  if (!fragments || fragments.length === 0) {
    return;
  }

  const normalized = normalizeText(text);
  for (const fragment of fragments) {
    if (
      normalized.includes(fragment.toLowerCase()) ||
      includesComparableFragment(text, fragment)
    ) {
      throw new Error(
        `${label} unexpectedly included "${fragment}".\nactual=${text}`,
      );
    }
  }
}

async function assertJudgePasses(args: {
  label: string;
  provider: SelectedLiveProvider;
  rubric?: { minimumScore?: number; rubric: string };
  text: string;
  transcript?: string;
}): Promise<void> {
  if (!args.rubric) {
    return;
  }
  const result = await judgeTextWithLlm({
    provider: args.provider,
    rubric: args.rubric.rubric,
    text: args.text,
    minimumScore: args.rubric.minimumScore,
    label: args.label,
    transcript: args.transcript,
  });
  if (!result.passed) {
    throw new Error(
      `${args.label} did not satisfy judge rubric (score ${result.score}). ${result.reasoning}`,
    );
  }
}

function definitionMatchesTitle(
  entry: LifeOpsDefinitionEntry,
  title: string,
  titleAliases: string[] = [],
): boolean {
  const entryTitle = String(entry.definition?.title ?? "");
  const normalizedTitle = normalizeText(entryTitle);
  return [title, ...titleAliases].some(
    (candidate) =>
      normalizedTitle === normalizeText(candidate) ||
      includesComparableFragment(entryTitle, candidate) ||
      includesComparableFragment(candidate, entryTitle),
  );
}

function goalMatchesTitle(
  entry: LifeOpsGoalEntry,
  title: string,
  titleAliases: string[] = [],
): boolean {
  const entryTitle = String(entry.goal?.title ?? "");
  const normalizedTitle = normalizeText(entryTitle);
  return [title, ...titleAliases].some(
    (candidate) =>
      normalizedTitle === normalizeText(candidate) ||
      includesComparableFragment(entryTitle, candidate) ||
      includesComparableFragment(candidate, entryTitle),
  );
}

function renderTurnText(turn: ScenarioTurn): string {
  if (turn.apiRequest) {
    return `${turn.apiRequest.method} ${turn.apiRequest.path}`;
  }
  if (typeof turn.text === "string" && turn.text.trim().length > 0) {
    return turn.text;
  }
  throw new Error(`Scenario turn "${turn.name}" did not provide text.`);
}

type ScenarioTemplateContext = {
  anchorNow: Date;
  port: number;
};

function applyOffsetToDate(
  anchorNow: Date,
  sign: "+" | "-",
  amount: number,
  unit: "m" | "h" | "d",
): Date {
  const next = new Date(anchorNow.getTime());
  const delta = sign === "-" ? -amount : amount;
  switch (unit) {
    case "m":
      next.setUTCMinutes(next.getUTCMinutes() + delta);
      return next;
    case "h":
      next.setUTCHours(next.getUTCHours() + delta);
      return next;
    case "d":
      next.setUTCDate(next.getUTCDate() + delta);
      return next;
  }
}

async function resolveScenarioToken(
  token: string,
  context: ScenarioTemplateContext,
): Promise<string> {
  const nowMatch = token.match(
    /^now(?:(?<sign>[+-])(?<amount>\d+)(?<unit>[mhd]))?$/,
  );
  if (nowMatch?.groups) {
    const { sign, amount, unit } = nowMatch.groups;
    if (!sign || !amount || !unit) {
      return context.anchorNow.toISOString();
    }
    return applyOffsetToDate(
      context.anchorNow,
      sign as "+" | "-",
      Number(amount),
      unit as "m" | "h" | "d",
    ).toISOString();
  }

  if (token.startsWith("definitionId:")) {
    return resolveDefinitionIdByTitle(
      context.port,
      token.slice("definitionId:".length).trim(),
    );
  }

  if (token.startsWith("occurrenceId:")) {
    return resolveOccurrenceIdByTitle(
      context.port,
      token.slice("occurrenceId:".length).trim(),
    );
  }

  throw new Error(`Unsupported scenario template token "${token}"`);
}

async function resolveScenarioTemplates(
  value: unknown,
  context: ScenarioTemplateContext,
): Promise<unknown> {
  if (typeof value === "string") {
    const matches = Array.from(value.matchAll(/\{\{([^}]+)\}\}/g));
    if (matches.length === 0) {
      return value;
    }

    let resolved = value;
    for (const match of matches) {
      const token = (match[1] ?? "").trim();
      const replacement = await resolveScenarioToken(token, context);
      resolved = resolved.replace(match[0], replacement);
    }
    return resolved;
  }

  if (Array.isArray(value)) {
    const resolvedEntries = [];
    for (const entry of value) {
      resolvedEntries.push(await resolveScenarioTemplates(entry, context));
    }
    return resolvedEntries;
  }

  if (value && typeof value === "object") {
    const resolvedObject: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      resolvedObject[key] = await resolveScenarioTemplates(entry, context);
    }
    return resolvedObject;
  }

  return value;
}

async function executeScenarioApiTurn(args: {
  runtime: StartedLifeOpsLiveRuntime;
  turn: ScenarioTurn;
  anchorNow: Date;
}): Promise<{
  responseText: string;
  text: string;
}> {
  const apiRequest = args.turn.apiRequest;
  if (!apiRequest) {
    throw new Error(
      `Scenario turn "${args.turn.name}" did not provide an apiRequest.`,
    );
  }

  const context: ScenarioTemplateContext = {
    anchorNow: args.anchorNow,
    port: args.runtime.port,
  };
  const resolvedPath = String(
    await resolveScenarioTemplates(apiRequest.path, context),
  );
  const resolvedBody = apiRequest.body
    ? await resolveScenarioTemplates(apiRequest.body, context)
    : undefined;
  const method = apiRequest.method.toUpperCase() as "GET" | "POST";
  const response = await req(
    args.runtime.port,
    method,
    resolvedPath,
    method === "POST" ? resolvedBody : undefined,
    undefined,
    { timeoutMs: LIVE_API_TURN_TIMEOUT_MS },
  );
  const expectedStatus = args.turn.apiStatus ?? (method === "POST" ? 200 : 200);
  if (response.status !== expectedStatus) {
    throw new Error(
      `${args.turn.name} expected API status ${expectedStatus} but saw ${response.status} for ${method} ${resolvedPath}: ${JSON.stringify(response.data)}`,
    );
  }

  const responseText = JSON.stringify(response.data);
  assertIncludesAll(
    `${args.turn.name} api response`,
    responseText,
    args.turn.apiResponseIncludesAll,
  );
  assertIncludesAny(
    `${args.turn.name} api response`,
    responseText,
    args.turn.apiResponseIncludesAny,
  );
  assertExcludes(
    `${args.turn.name} api response`,
    responseText,
    args.turn.apiResponseExcludes,
  );

  return {
    responseText,
    text:
      method === "POST"
        ? `${method} ${resolvedPath} ${JSON.stringify(resolvedBody)}`
        : `${method} ${resolvedPath}`,
  };
}

async function createScenarioRooms(
  runtime: StartedLifeOpsLiveRuntime,
  scenario: LifeOpsLiveScenario,
): Promise<Map<string, { conversationId: string; source: string }>> {
  const rooms = scenario.rooms?.length
    ? scenario.rooms
    : [{ id: "main", source: "discord", title: scenario.title }];

  const created = new Map<string, { conversationId: string; source: string }>();
  for (const room of rooms) {
    const conversation = await createConversation(
      runtime.port,
      {
        title: room.title ?? `${scenario.title} (${room.id})`,
      },
      undefined,
      { timeoutMs: LIVE_ROOM_CREATION_TIMEOUT_MS },
    );
    created.set(room.id, {
      conversationId: conversation.conversationId,
      source: room.source ?? "discord",
    });
  }

  return created;
}

async function waitForScenarioTurnSideEffects(args: {
  runtime: StartedLifeOpsLiveRuntime;
  turn: ScenarioTurn;
}): Promise<void> {
  if (args.turn.waitForDefinitionTitle) {
    const deadline = Date.now() + FINAL_CHECK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const definitions = await listDefinitionEntries(args.runtime.port);
      const match = definitions.find((entry) =>
        definitionMatchesTitle(
          entry,
          args.turn.waitForDefinitionTitle!,
          args.turn.waitForDefinitionTitleAliases,
        ),
      );
      if (match) {
        break;
      }
      await sleep(FINAL_CHECK_RETRY_MS);
    }

    const refreshedDefinitions = await listDefinitionEntries(args.runtime.port);
    const definitionMatch = refreshedDefinitions.find((entry) =>
      definitionMatchesTitle(
        entry,
        args.turn.waitForDefinitionTitle!,
        args.turn.waitForDefinitionTitleAliases,
      ),
    );
    if (!definitionMatch) {
      throw new Error(
        `Timed out waiting for definition "${args.turn.waitForDefinitionTitle}"`,
      );
    }
  }

  if (args.turn.waitForGoalTitle) {
    const deadline = Date.now() + FINAL_CHECK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const goals = await listGoalEntries(args.runtime.port);
      const match = goals.find((entry) =>
        goalMatchesTitle(
          entry,
          args.turn.waitForGoalTitle!,
          args.turn.waitForGoalTitleAliases,
        ),
      );
      if (match) {
        break;
      }
      await sleep(FINAL_CHECK_RETRY_MS);
    }

    const refreshedGoals = await listGoalEntries(args.runtime.port);
    const goalMatch = refreshedGoals.find((entry) =>
      goalMatchesTitle(
        entry,
        args.turn.waitForGoalTitle!,
        args.turn.waitForGoalTitleAliases,
      ),
    );
    if (!goalMatch) {
      throw new Error(
        `Timed out waiting for goal "${args.turn.waitForGoalTitle}"`,
      );
    }
  }
}

async function collectScenarioBaseline(
  runtime: StartedLifeOpsLiveRuntime,
  scenario: LifeOpsLiveScenario,
): Promise<{
  definitionCounts: Map<string, number>;
  goalCounts: Map<string, number>;
}> {
  const definitionTitles = new Set<string>();
  const goalTitles = new Set<string>();

  for (const check of scenario.finalChecks ?? []) {
    if (
      check.type === "definitionCountDelta" ||
      check.type === "reminderIntensity"
    ) {
      definitionTitles.add(check.title);
      continue;
    }
    if (check.type === "goalCountDelta") {
      goalTitles.add(check.title);
    }
  }

  const definitions = await listDefinitionEntries(runtime.port);
  const goals = await listGoalEntries(runtime.port);

  const definitionCounts = new Map<string, number>();
  for (const title of definitionTitles) {
    const matchingChecks = (scenario.finalChecks ?? []).filter(
      (check): check is DefinitionCountDeltaCheck | ReminderIntensityCheck =>
        (check.type === "definitionCountDelta" ||
          check.type === "reminderIntensity") &&
        check.title === title,
    );
    const titleAliases = matchingChecks.flatMap(
      (check) => check.titleAliases ?? [],
    );
    definitionCounts.set(
      title,
      definitions.filter((entry) =>
        definitionMatchesTitle(entry, title, titleAliases),
      ).length,
    );
  }

  const goalCounts = new Map<string, number>();
  for (const title of goalTitles) {
    const matchingChecks = (scenario.finalChecks ?? []).filter(
      (check): check is GoalCountDeltaCheck =>
        check.type === "goalCountDelta" && check.title === title,
    );
    const titleAliases = matchingChecks.flatMap(
      (check) => check.titleAliases ?? [],
    );
    goalCounts.set(
      title,
      goals.filter((entry) => goalMatchesTitle(entry, title, titleAliases))
        .length,
    );
  }

  return { definitionCounts, goalCounts };
}

async function validateFinalChecks(args: {
  baseline: Awaited<ReturnType<typeof collectScenarioBaseline>>;
  runtime: StartedLifeOpsLiveRuntime;
  scenario: LifeOpsLiveScenario;
}): Promise<
  Array<{ label: string; status: "passed" | "failed"; detail: string }>
> {
  const results: Array<{
    label: string;
    status: "passed" | "failed";
    detail: string;
  }> = [];
  const definitions = await listDefinitionEntries(args.runtime.port);
  const goals = await listGoalEntries(args.runtime.port);

  for (const check of args.scenario.finalChecks ?? []) {
    const label = `${args.scenario.id}:${check.type}:${check.title}`;
    try {
      if (check.type === "definitionCountDelta") {
        const matches = definitions.filter((entry) =>
          definitionMatchesTitle(entry, check.title, check.titleAliases),
        );
        const beforeCount =
          args.baseline.definitionCounts.get(check.title) ?? 0;
        const delta = matches.length - beforeCount;
        if (delta !== check.delta) {
          throw new Error(
            `expected definition delta ${check.delta} for "${check.title}" but saw ${delta}`,
          );
        }

        const latest = matches[matches.length - 1];
        if (check.delta > 0 && !latest) {
          throw new Error(
            `expected to find "${check.title}" after the scenario`,
          );
        }
        if (latest && check.cadenceKind) {
          const cadence =
            latest.definition?.cadence &&
            typeof latest.definition.cadence === "object"
              ? (latest.definition.cadence as Record<string, unknown>)
              : null;
          if (String(cadence?.kind ?? "") !== check.cadenceKind) {
            throw new Error(
              `expected cadence kind ${check.cadenceKind} but saw ${String(cadence?.kind ?? "")}`,
            );
          }
          if (check.requiredWindows?.length) {
            const windows = Array.isArray(cadence?.windows)
              ? cadence.windows.map((entry) => String(entry))
              : [];
            for (const window of check.requiredWindows) {
              if (!windows.includes(window)) {
                throw new Error(`expected cadence window "${window}"`);
              }
            }
          }
          if (check.requiredWeekdays?.length) {
            const weekdays = Array.isArray(cadence?.weekdays)
              ? cadence.weekdays.map((entry) => Number(entry))
              : [];
            for (const weekday of check.requiredWeekdays) {
              if (!weekdays.includes(weekday)) {
                throw new Error(`expected cadence weekday "${weekday}"`);
              }
            }
          }
          if (check.requiredSlots?.length) {
            const slots = Array.isArray(cadence?.slots) ? cadence.slots : [];
            for (const requiredSlot of check.requiredSlots) {
              const matchedSlot = slots.find((candidate) => {
                if (!candidate || typeof candidate !== "object") {
                  return false;
                }
                const slot = candidate as Record<string, unknown>;
                if (
                  typeof requiredSlot.label === "string" &&
                  String(slot.label ?? "") !== requiredSlot.label
                ) {
                  return false;
                }
                if (
                  typeof requiredSlot.minuteOfDay === "number" &&
                  Number(slot.minuteOfDay ?? -1) !== requiredSlot.minuteOfDay
                ) {
                  return false;
                }
                return true;
              });
              if (!matchedSlot) {
                throw new Error(
                  `missing required slot ${JSON.stringify(requiredSlot)}`,
                );
              }
            }
          }
          if (typeof check.requiredEveryMinutes === "number") {
            if (
              Number(cadence?.everyMinutes ?? -1) !== check.requiredEveryMinutes
            ) {
              throw new Error(
                `expected everyMinutes ${check.requiredEveryMinutes} but saw ${String(cadence?.everyMinutes ?? "")}`,
              );
            }
          }
          if (typeof check.requiredMaxOccurrencesPerDay === "number") {
            if (
              Number(cadence?.maxOccurrencesPerDay ?? -1) !==
              check.requiredMaxOccurrencesPerDay
            ) {
              throw new Error(
                `expected maxOccurrencesPerDay ${check.requiredMaxOccurrencesPerDay} but saw ${String(cadence?.maxOccurrencesPerDay ?? "")}`,
              );
            }
          }
        }

        if (latest && check.requireReminderPlan) {
          const reminderPlanId = String(latest.reminderPlan?.id ?? "");
          if (!reminderPlanId) {
            throw new Error(`expected a reminder plan for "${check.title}"`);
          }
        }

        if (latest && check.expectedTimeZone) {
          if (
            String(latest.definition?.timezone ?? "") !== check.expectedTimeZone
          ) {
            throw new Error(
              `expected definition timezone ${check.expectedTimeZone} but saw ${String(latest.definition?.timezone ?? "")}`,
            );
          }
        }

        if (latest && check.websiteAccess) {
          const websiteAccess =
            latest.definition?.websiteAccess &&
            typeof latest.definition.websiteAccess === "object"
              ? (latest.definition.websiteAccess as Record<string, unknown>)
              : null;
          if (
            check.websiteAccess.unlockMode &&
            String(websiteAccess?.unlockMode ?? "") !==
              check.websiteAccess.unlockMode
          ) {
            throw new Error(
              `expected websiteAccess.unlockMode=${check.websiteAccess.unlockMode}`,
            );
          }
          if (
            typeof check.websiteAccess.unlockDurationMinutes === "number" &&
            Number(websiteAccess?.unlockDurationMinutes ?? -1) !==
              check.websiteAccess.unlockDurationMinutes
          ) {
            throw new Error(
              `expected websiteAccess.unlockDurationMinutes=${check.websiteAccess.unlockDurationMinutes}`,
            );
          }
          if (check.websiteAccess.websites?.length) {
            const websites = Array.isArray(websiteAccess?.websites)
              ? websiteAccess.websites.map((entry) => String(entry))
              : [];
            for (const website of check.websiteAccess.websites) {
              if (!websites.includes(website)) {
                throw new Error(`expected website "${website}"`);
              }
            }
          }
        }
      } else if (check.type === "reminderIntensity") {
        const matches = definitions.filter((entry) =>
          definitionMatchesTitle(entry, check.title, check.titleAliases),
        );
        const latest = matches[matches.length - 1];
        const definitionId = String(latest?.definition?.id ?? "");
        if (!definitionId) {
          throw new Error(
            `could not resolve a definition id for "${check.title}"`,
          );
        }
        const preference = await getReminderPreference(
          args.runtime.port,
          definitionId,
        );
        const effective =
          preference.effective && typeof preference.effective === "object"
            ? (preference.effective as Record<string, unknown>)
            : null;
        if (String(effective?.intensity ?? "") !== check.expected) {
          throw new Error(
            `expected reminder intensity ${check.expected} but saw ${String(effective?.intensity ?? "")}`,
          );
        }
      } else if (check.type === "goalCountDelta") {
        const matches = goals.filter((entry) =>
          goalMatchesTitle(entry, check.title, check.titleAliases),
        );
        const beforeCount = args.baseline.goalCounts.get(check.title) ?? 0;
        const delta = matches.length - beforeCount;
        if (delta !== check.delta) {
          throw new Error(
            `expected goal delta ${check.delta} for "${check.title}" but saw ${delta}`,
          );
        }
        const latest = matches[matches.length - 1];
        if (check.delta > 0 && !latest) {
          throw new Error(`expected to find goal "${check.title}"`);
        }
        if (
          latest &&
          check.expectedStatus &&
          String(latest.goal?.status ?? "") !== check.expectedStatus
        ) {
          throw new Error(`expected goal status ${check.expectedStatus}`);
        }
        if (
          latest &&
          check.expectedReviewState &&
          String(latest.goal?.reviewState ?? "") !== check.expectedReviewState
        ) {
          throw new Error(
            `expected goal reviewState ${check.expectedReviewState}`,
          );
        }
        if (
          latest &&
          check.requireDescription &&
          String(latest.goal?.description ?? "").trim().length === 0
        ) {
          throw new Error(
            `expected goal "${check.title}" to include description`,
          );
        }
        if (
          latest &&
          check.requireSuccessCriteria &&
          (!latest.goal?.successCriteria ||
            typeof latest.goal.successCriteria !== "object" ||
            Array.isArray(latest.goal.successCriteria) ||
            Object.keys(latest.goal.successCriteria).length === 0)
        ) {
          throw new Error(
            `expected goal "${check.title}" to include success criteria`,
          );
        }
        if (
          latest &&
          check.requireSupportStrategy &&
          (!latest.goal?.supportStrategy ||
            typeof latest.goal.supportStrategy !== "object" ||
            Array.isArray(latest.goal.supportStrategy) ||
            Object.keys(latest.goal.supportStrategy).length === 0)
        ) {
          throw new Error(
            `expected goal "${check.title}" to include support strategy`,
          );
        }
        if (latest && check.expectedGroundingState) {
          const metadata =
            latest.goal?.metadata && typeof latest.goal.metadata === "object"
              ? (latest.goal.metadata as Record<string, unknown>)
              : null;
          const goalGrounding =
            metadata?.goalGrounding &&
            typeof metadata.goalGrounding === "object" &&
            !Array.isArray(metadata.goalGrounding)
              ? (metadata.goalGrounding as Record<string, unknown>)
              : null;
          if (
            String(goalGrounding?.groundingState ?? "") !==
            check.expectedGroundingState
          ) {
            throw new Error(
              `expected goal groundingState ${check.expectedGroundingState} but saw ${String(goalGrounding?.groundingState ?? "")}`,
            );
          }
        }
      }

      results.push({ label, status: "passed", detail: "ok" });
    } catch (error) {
      results.push({
        label,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return results;
}

async function waitForFinalChecks(args: {
  baseline: Awaited<ReturnType<typeof collectScenarioBaseline>>;
  runtime: StartedLifeOpsLiveRuntime;
  scenario: LifeOpsLiveScenario;
}): Promise<
  Array<{ label: string; status: "passed" | "failed"; detail: string }>
> {
  const deadline = Date.now() + FINAL_CHECK_TIMEOUT_MS;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      return await validateFinalChecks(args);
    } catch (error) {
      lastError = error;
      await sleep(FINAL_CHECK_RETRY_MS);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for scenario final checks to settle.");
}

export async function runLifeOpsLiveScenario(args: {
  onProgress?: (event: ScenarioProgressEvent) => void;
  runtime: StartedLifeOpsLiveRuntime;
  scenario: LifeOpsLiveScenario;
  selectedProvider: SelectedLiveProvider;
}): Promise<ScenarioReport> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const anchorNow = new Date();
  const turns: ScenarioTurnReport[] = [];
  const baseline = await collectScenarioBaseline(args.runtime, args.scenario);

  try {
    args.onProgress?.({
      type: "scenario:start",
      scenarioId: args.scenario.id,
      title: args.scenario.title,
    });
    const rooms = await createScenarioRooms(args.runtime, args.scenario);

    for (const [index, turn] of args.scenario.turns.entries()) {
      args.onProgress?.({
        type: "turn:start",
        index: index + 1,
        scenarioId: args.scenario.id,
        total: args.scenario.turns.length,
        turnName: turn.name,
      });
      if (turn.apiRequest) {
        const apiResult = await executeScenarioApiTurn({
          runtime: args.runtime,
          turn,
          anchorNow,
        });
        turns.push({
          conversationId: "",
          name: turn.name,
          responseText: apiResult.responseText,
          source: "api",
          text: apiResult.text,
        });
        args.onProgress?.({
          type: "turn:complete",
          index: index + 1,
          scenarioId: args.scenario.id,
          total: args.scenario.turns.length,
          turnName: turn.name,
        });
        continue;
      }

      const room = rooms.get(turn.room ?? "main");
      if (!room) {
        throw new Error(
          `Scenario "${args.scenario.id}" referenced an unknown room "${turn.room ?? "main"}"`,
        );
      }

      const text = renderTurnText(turn);
      const responseText = await postLiveConversationMessage(
        args.runtime,
        room.conversationId,
        text,
        turn.name,
        turn.attempts ?? 3,
        turn.source ?? room.source,
      );

      let plannerResponse = "";
      let trajectoryId = "";
      if (
        turn.plannerIncludesAll?.length ||
        turn.plannerIncludesAny?.length ||
        turn.plannerExcludes?.length ||
        turn.plannerJudge
      ) {
        const trajectory = await waitForTrajectoryCall(
          args.runtime.port,
          text,
          turn.trajectoryTimeoutMs,
        );
        plannerResponse = String(trajectory.llmCall.response ?? "");
        trajectoryId = trajectory.trajectoryId;
        assertIncludesAll(
          `${turn.name} planner`,
          plannerResponse,
          turn.plannerIncludesAll,
        );
        assertIncludesAny(
          `${turn.name} planner`,
          plannerResponse,
          turn.plannerIncludesAny,
        );
        assertExcludes(
          `${turn.name} planner`,
          plannerResponse,
          turn.plannerExcludes,
        );
        await assertJudgePasses({
          label: `${turn.name} planner`,
          provider: args.selectedProvider,
          rubric: turn.plannerJudge,
          text: plannerResponse,
          transcript: `User: ${text}`,
        });
      }

      turns.push({
        conversationId: room.conversationId,
        name: turn.name,
        plannerResponse: plannerResponse || undefined,
        responseText,
        source: turn.source ?? room.source,
        text,
        trajectoryId: trajectoryId || undefined,
      });

      assertNoProviderIssue(turn.name, responseText, args.runtime);
      assertIncludesAll(
        `${turn.name} response`,
        responseText,
        turn.responseIncludesAll,
      );
      assertIncludesAny(
        `${turn.name} response`,
        responseText,
        turn.responseIncludesAny,
      );
      assertExcludes(
        `${turn.name} response`,
        responseText,
        turn.responseExcludes,
      );
      await assertJudgePasses({
        label: `${turn.name} response`,
        provider: args.selectedProvider,
        rubric: turn.responseJudge,
        text: responseText,
        transcript: [
          ...turns
            .slice(-4)
            .map(
              (entry) =>
                `${entry.source === "api" ? "API" : "User"}: ${entry.text}\nAssistant: ${entry.responseText}`,
            ),
          `User: ${text}`,
        ].join("\n\n"),
      });
      await waitForScenarioTurnSideEffects({
        runtime: args.runtime,
        turn,
      });
      args.onProgress?.({
        type: "turn:complete",
        index: index + 1,
        scenarioId: args.scenario.id,
        total: args.scenario.turns.length,
        turnName: turn.name,
      });
    }

    const finalChecks = await waitForFinalChecks({
      baseline,
      runtime: args.runtime,
      scenario: args.scenario,
    });

    const report = {
      durationMs: Date.now() - startedMs,
      finalChecks,
      id: args.scenario.id,
      providerName: args.runtime.providerName,
      startedAt,
      status: "passed",
      title: args.scenario.title,
      turns,
    };
    args.onProgress?.({
      type: "scenario:complete",
      durationMs: report.durationMs,
      scenarioId: args.scenario.id,
      status: report.status,
      title: args.scenario.title,
    });
    return report;
  } catch (error) {
    const report = {
      durationMs: Date.now() - startedMs,
      error: error instanceof Error ? error.message : String(error),
      finalChecks: [],
      id: args.scenario.id,
      providerName: args.runtime.providerName,
      startedAt,
      status: "failed",
      title: args.scenario.title,
      turns,
    };
    args.onProgress?.({
      type: "scenario:complete",
      durationMs: report.durationMs,
      error: report.error,
      scenarioId: args.scenario.id,
      status: report.status,
      title: args.scenario.title,
    });
    return report;
  }
}

export async function loadLifeOpsScenarioCatalog(
  dir: string = DEFAULT_SCENARIO_DIR,
): Promise<LifeOpsLiveScenario[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const scenarios: LifeOpsLiveScenario[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    const raw = await readFile(filePath, "utf8");
    scenarios.push(JSON.parse(raw) as LifeOpsLiveScenario);
  }

  scenarios.sort((left, right) => left.id.localeCompare(right.id));
  return scenarios;
}

export async function runLifeOpsScenarioMatrix(options?: {
  isolate?: "shared" | "per-scenario";
  onProgress?: (event: ScenarioProgressEvent) => void;
  reportPath?: string;
  scenarioIds?: string[];
  selectedProvider?: SelectedLiveProvider | null;
}): Promise<{ report: ScenarioMatrixReport; reportPath: string }> {
  const catalog = await loadLifeOpsScenarioCatalog();
  const selectedIds = new Set(options?.scenarioIds ?? []);
  const scenarios =
    selectedIds.size > 0
      ? catalog.filter((scenario) => selectedIds.has(scenario.id))
      : catalog;

  if (scenarios.length === 0) {
    throw new Error("No LifeOps scenarios matched the requested selection.");
  }

  const selectedProvider =
    options?.selectedProvider ?? (await selectLifeOpsLiveProvider());
  if (!selectedProvider) {
    throw new Error(
      "No live provider is configured for the LifeOps scenario run.",
    );
  }

  const isolate = options?.isolate ?? "per-scenario";
  const reports: ScenarioReport[] = [];
  let sharedRuntime: StartedLifeOpsLiveRuntime | null = null;

  if (
    isolate === "shared" &&
    scenarios.some((scenario) => !scenario.requiresIsolation)
  ) {
    options?.onProgress?.({ type: "runtime:start", mode: "shared" });
    sharedRuntime = await startLifeOpsLiveRuntime({ selectedProvider });
    options?.onProgress?.({ type: "runtime:ready", mode: "shared" });
  }

  try {
    for (const scenario of scenarios) {
      const useIsolatedRuntime =
        isolate === "per-scenario" || scenario.requiresIsolation === true;
      const runtime = useIsolatedRuntime
        ? await (async () => {
            options?.onProgress?.({
              type: "runtime:start",
              mode: "isolated",
              scenarioId: scenario.id,
            });
            const started = await startLifeOpsLiveRuntime({ selectedProvider });
            options?.onProgress?.({
              type: "runtime:ready",
              mode: "isolated",
              scenarioId: scenario.id,
            });
            return started;
          })()
        : (sharedRuntime as StartedLifeOpsLiveRuntime);

      try {
        reports.push(
          await runLifeOpsLiveScenario({
            onProgress: options?.onProgress,
            runtime,
            scenario,
            selectedProvider,
          }),
        );
      } finally {
        if (useIsolatedRuntime) {
          await runtime.close();
        }
      }
    }
  } finally {
    if (sharedRuntime) {
      await sharedRuntime.close();
    }
  }

  const report: ScenarioMatrixReport = {
    completedAt: new Date().toISOString(),
    failedCount: reports.filter((entry) => entry.status === "failed").length,
    providerName: selectedProvider.name,
    scenarios: reports,
    startedAt:
      reports.length > 0 ? reports[0].startedAt : new Date().toISOString(),
    totalCount: reports.length,
  };

  const reportPath =
    options?.reportPath ??
    path.join(REPO_ROOT, ".tmp", `lifeops-scenario-report-${Date.now()}.json`);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, reportPath };
}
