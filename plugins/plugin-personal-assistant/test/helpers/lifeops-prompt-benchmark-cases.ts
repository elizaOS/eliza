/**
 * Loads LifeOps prompt-benchmark scenario cases from disk and normalizes their turn and
 * final-check shapes for the benchmark runner.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

type ScenarioTurnLike = {
  kind?: string;
  name?: string;
  text?: string;
  [key: string]: unknown;
};

type ScenarioFinalCheckLike = {
  type?: string;
  actionName?: string | string[];
  [key: string]: unknown;
};

export type ScenarioLike = {
  id: string;
  title: string;
  domain: string;
  tags?: string[];
  turns: ScenarioTurnLike[];
  finalChecks?: ScenarioFinalCheckLike[];
};

type ExecutiveAssistantCatalogScenario = {
  id: string;
  suite: string;
  examplePrompt: string;
  benchmarkPrompt?: string;
  actions: string[];
};

type ExecutiveAssistantCatalog = {
  catalogId: string;
  scenarios: ExecutiveAssistantCatalogScenario[];
};

export const SELF_CARE_PRD_SCENARIO_IDS = [
  "workout-blocker-basic",
  "stretch-breaks",
  "goal-sleep-basic",
  "shower-weekly-basic",
  "shave-weekly-formal",
  "brush-teeth-basic",
  "brush-teeth-bedtime-wakeup",
  "brush-teeth-night-owl",
  "brush-teeth-repeat-confirm",
  "brush-teeth-retry-after-cancel",
  "brush-teeth-cancel",
  "brush-teeth-spanish",
  "brush-teeth-smalltalk-preference",
  "vitamins-with-meals",
  "water-default-frequency",
  "invisalign-weekday-lunch",
] as const;

export const SELF_CARE_HABIT_SCENARIO_IDS = [
  "habit.sit-ups-push-ups.daily-counts",
  "habit.morning-routine.full-stack",
  "habit.night-routine.full-stack",
] as const;

export const PROMPT_BENCHMARK_VARIANT_IDS = [
  "direct",
  "adult-formal",
  "childlike",
  "broken-english",
  "naive-underspecified",
  "expert-shorthand",
  "distracted-rambling",
  "voice-asr",
  "self-correcting",
  "subtle-null",
] as const;

export type PromptBenchmarkVariantId =
  (typeof PROMPT_BENCHMARK_VARIANT_IDS)[number];

export type PromptBenchmarkSuiteId =
  | "lifeops-self-care"
  | "lifeops-executive-assistant"
  | "lifeops-capability-coverage";

export type PromptBenchmarkRiskClass = "positive" | "edge" | "null";

export const LIFEOPS_PROMPT_BENCHMARK_TASKS = [
  "calendar_extract",
  "schedule_plan",
  "reminder_dispatch",
  "inbox_triage",
  "meeting_prep",
  "morning_brief",
  "health_checkin",
  "screentime_recap",
] as const;

export type LifeOpsPromptBenchmarkTask =
  (typeof LIFEOPS_PROMPT_BENCHMARK_TASKS)[number];

export type PromptBenchmarkCase = {
  caseId: string;
  suiteId: PromptBenchmarkSuiteId;
  baseScenarioId: string;
  scenarioTitle: string;
  domain: string;
  basePrompt: string;
  prompt: string;
  benchmarkContext: string;
  optimizationTask: LifeOpsPromptBenchmarkTask;
  variantId: PromptBenchmarkVariantId;
  variantLabel: string;
  axes: string[];
  riskClass: PromptBenchmarkRiskClass;
  benchmarkWeight: number;
  expectedAction: string | null;
  acceptableActions: string[];
  forbiddenActions: string[];
  expectedOperation: string | null;
  tags: string[];
  notes?: string;
};

type BenchmarkExpectation = {
  expectedAction: string | null;
  acceptableActions?: string[];
  forbiddenActions?: string[];
  expectedOperation?: string | null;
  notes?: string;
};

type PromptVariantDefinition = {
  id: PromptBenchmarkVariantId;
  label: string;
  axes: string[];
  riskClass: PromptBenchmarkRiskClass;
  benchmarkWeight: number;
  shouldExecute: boolean;
  rewrite: (basePrompt: string) => string;
};

const ELIZA_ROOT = path.resolve(import.meta.dirname, "../../../..");
const ELIZA_SCENARIO_ROOT = path.join(
  ELIZA_ROOT,
  "packages",
  "test",
  "scenarios",
);
const EXECUTIVE_ASSISTANT_SCENARIO_DIR = path.join(
  ELIZA_SCENARIO_ROOT,
  "executive-assistant",
);
const EXECUTIVE_ASSISTANT_CATALOG_PATH = path.join(
  import.meta.dirname,
  "..",
  "scenarios",
  "_catalogs",
  "executive-assistant-transcript.catalog.json",
);
const SELF_CARE_SCENARIO_DIR = path.join(
  import.meta.dirname,
  "..",
  "scenarios",
);
const SELF_CARE_HABIT_SCENARIO_DIR = path.join(
  ELIZA_SCENARIO_ROOT,
  "lifeops.habits",
);

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter((value) => value.length > 0),
    ),
  );
}

function removeTerminalPunctuation(text: string): string {
  return text.replace(/[.!?]+$/u, "").trim();
}

function stripPunctuation(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function lowercaseFirst(text: string): string {
  if (!text) {
    return text;
  }
  return `${text[0]?.toLowerCase() ?? ""}${text.slice(1)}`;
}

function normalizeSentence(text: string): string {
  return removeTerminalPunctuation(text).trim();
}

const PROMPT_BENCHMARK_VARIANTS: readonly PromptVariantDefinition[] = [
  {
    id: "direct",
    label: "Direct",
    axes: ["baseline", "direct"],
    riskClass: "positive",
    benchmarkWeight: 1,
    shouldExecute: true,
    rewrite: (basePrompt) => basePrompt,
  },
  {
    id: "adult-formal",
    label: "Adult Formal",
    axes: ["adult", "formal-register"],
    riskClass: "positive",
    benchmarkWeight: 1,
    shouldExecute: true,
    rewrite: (basePrompt) =>
      `Please handle this carefully: ${normalizeSentence(basePrompt)}.`,
  },
  {
    id: "childlike",
    label: "Childlike",
    axes: ["childlike", "simple-language"],
    riskClass: "positive",
    benchmarkWeight: 1.05,
    shouldExecute: true,
    rewrite: (basePrompt) =>
      `Can you help me with this please? ${normalizeSentence(basePrompt)}.`,
  },
  {
    id: "broken-english",
    label: "Broken English",
    axes: ["multilingual", "broken-english"],
    riskClass: "edge",
    benchmarkWeight: 1.2,
    shouldExecute: true,
    rewrite: (basePrompt) =>
      `sorry my english not perfect but ${lowercaseFirst(normalizeSentence(basePrompt))} please`,
  },
  {
    id: "naive-underspecified",
    label: "Naive",
    axes: ["underspecified", "naive-mental-model"],
    riskClass: "edge",
    benchmarkWeight: 1.15,
    shouldExecute: true,
    rewrite: (basePrompt) =>
      `I might be saying this badly, but I think I need this: ${lowercaseFirst(normalizeSentence(basePrompt))}.`,
  },
  {
    id: "expert-shorthand",
    label: "Expert Shorthand",
    axes: ["expert-shorthand", "compressed"],
    riskClass: "positive",
    benchmarkWeight: 1.1,
    shouldExecute: true,
    rewrite: (basePrompt) =>
      `Handle this fast. ${normalizeSentence(basePrompt)}.`,
  },
  {
    id: "distracted-rambling",
    label: "Distracted",
    axes: ["distracted", "rambling"],
    riskClass: "edge",
    benchmarkWeight: 1.15,
    shouldExecute: true,
    rewrite: (basePrompt) =>
      `I'm multitasking and might be rambling, but ${lowercaseFirst(normalizeSentence(basePrompt))}.`,
  },
  {
    id: "voice-asr",
    label: "Voice ASR",
    axes: ["speech", "asr-noise"],
    riskClass: "edge",
    benchmarkWeight: 1.1,
    shouldExecute: true,
    rewrite: (basePrompt) =>
      `uh ${stripPunctuation(basePrompt).toLowerCase()} thanks`,
  },
  {
    id: "self-correcting",
    label: "Self Correcting",
    axes: ["self-correction", "multi-phrase"],
    riskClass: "edge",
    benchmarkWeight: 1.15,
    shouldExecute: true,
    rewrite: (basePrompt) =>
      `${normalizeSentence(basePrompt)}. Actually, wait, let me say it better: ${normalizeSentence(basePrompt)}.`,
  },
  {
    id: "subtle-null",
    label: "Subtle Null",
    axes: ["null-case", "non-request", "confuser"],
    riskClass: "null",
    benchmarkWeight: 2,
    shouldExecute: false,
    rewrite: (basePrompt) =>
      `Do not do this yet. I'm only thinking out loud: ${lowercaseFirst(normalizeSentence(basePrompt))}.`,
  },
] as const;

function firstMessageTurnText(scenario: ScenarioLike): string {
  const firstMessageTurn = scenario.turns.find((turn) => {
    const kind = String(turn.kind ?? "message");
    return kind === "message" && typeof turn.text === "string";
  });
  const text = String(firstMessageTurn?.text ?? "").trim();
  if (!text) {
    throw new Error(
      `Scenario "${scenario.id}" does not expose a first message turn.`,
    );
  }
  return text;
}

function extractScenarioSelectedActions(scenario: ScenarioLike): string[] {
  const selectedActions = uniqueStrings(
    (scenario.finalChecks ?? []).flatMap((check) => {
      const type = String(check.type ?? "");
      if (type !== "selectedAction" && type !== "actionCalled") {
        return [];
      }
      const actionName = check.actionName;
      return Array.isArray(actionName) ? actionName : [actionName];
    }),
  ).filter((actionName) => actionName !== "REPLY");

  return selectedActions;
}

function deriveSelfCareExpectation(
  scenario: ScenarioLike,
): BenchmarkExpectation {
  if (scenario.id === "brush-teeth-smalltalk-preference") {
    return {
      expectedAction: null,
      acceptableActions: ["REPLY"],
      forbiddenActions: ["LIFE"],
      expectedOperation: null,
      notes:
        "First-turn self-care smalltalk is a subtle non-request. Reply conversationally and wait until the user explicitly asks to create or save the routine.",
    };
  }

  const isGoalScenario = (scenario.finalChecks ?? []).some(
    (check) => String(check.type ?? "") === "goalCountDelta",
  );
  const requiresConfirmation =
    scenario.turns.length > 1 &&
    scenario.turns
      .slice(1)
      .some((turn) =>
        /save|confirm|yes|looks right|all of those/u.test(
          `${String(turn.name ?? "")} ${String(turn.text ?? "")}`.toLowerCase(),
        ),
      );

  if (requiresConfirmation) {
    const supportsBlockRule = /block\s+x|instagram|hacker news/iu.test(
      firstMessageTurnText(scenario),
    );
    return {
      expectedAction: "LIFE",
      acceptableActions: supportsBlockRule ? ["WEBSITE_BLOCK"] : [],
      forbiddenActions: [],
      expectedOperation: isGoalScenario ? "create_goal" : "create_definition",
      notes:
        "First-turn self-care request should route through LIFE while staying in preview/clarification mode until the user explicitly confirms.",
    };
  }

  return {
    expectedAction: "LIFE",
    acceptableActions: [],
    forbiddenActions: [],
    expectedOperation: isGoalScenario ? "create_goal" : "create_definition",
  };
}

function deriveExecutiveAssistantExpectation(
  scenario: ScenarioLike,
): BenchmarkExpectation {
  const selectedActions = extractScenarioSelectedActions(scenario);
  if (selectedActions.length === 0) {
    throw new Error(
      `Scenario "${scenario.id}" is missing a selectedAction/actionCalled benchmark anchor.`,
    );
  }

  return {
    expectedAction: selectedActions[0] ?? null,
    acceptableActions: selectedActions.slice(1),
    forbiddenActions: selectedActions,
    expectedOperation: null,
  };
}

function deriveOptimizationTask(args: {
  expectedAction: string | null;
  scenario: ScenarioLike;
}): LifeOpsPromptBenchmarkTask {
  const text = [
    args.scenario.id,
    args.scenario.title,
    args.scenario.domain,
    ...(args.scenario.tags ?? []),
    args.expectedAction ?? "",
  ]
    .join(" ")
    .toLowerCase();
  const expectedAction = String(args.expectedAction ?? "").toUpperCase();

  if (text.includes("screen") || text.includes("screentime")) {
    return "screentime_recap";
  }
  if (text.includes("health") || text.includes("sleep")) {
    return "health_checkin";
  }
  if (text.includes("brief") || text.includes("digest")) {
    return "morning_brief";
  }
  if (text.includes("meeting-prep") || text.includes("dossier")) {
    return "meeting_prep";
  }
  if (
    text.includes("inbox") ||
    text.includes("gmail") ||
    text.includes("messaging") ||
    expectedAction === "MESSAGE" ||
    expectedAction === "INBOX"
  ) {
    return "inbox_triage";
  }
  if (
    text.includes("reminder") ||
    text.includes("push") ||
    expectedAction === "OWNER_REMINDERS"
  ) {
    return "reminder_dispatch";
  }
  if (text.includes("scheduling negotiation") || text.includes("propose")) {
    return "schedule_plan";
  }
  if (text.includes("calendar") || expectedAction === "CALENDAR") {
    return "calendar_extract";
  }
  return "reminder_dispatch";
}

function buildPromptBenchmarkContext(args: {
  scenarioTitle: string;
  expectedAction: string | null;
}): string {
  if (args.expectedAction === null) {
    return `Prompt benchmark scenario "${args.scenarioTitle}". Treat this as a benchmark of restraint: the user may be thinking out loud, making smalltalk, or previewing a future task. Use only registered runtime action and provider names, and avoid executing durable actions unless the request is explicit.`;
  }

  return `Prompt benchmark scenario "${args.scenarioTitle}". Treat this as a benchmark of grounded follow-through: when the user is making a real request, prefer executing the best matching registered action instead of only describing a hypothetical plan. If details are missing, choose the owning action anyway and let that action ask the minimum follow-up. Use only registered runtime action and provider names.`;
}

function buildPromptBenchmarkCasesForScenario(args: {
  basePromptOverride?: string;
  expectation: BenchmarkExpectation;
  scenario: ScenarioLike;
  suiteId: PromptBenchmarkSuiteId;
}): PromptBenchmarkCase[] {
  const { expectation, scenario, suiteId } = args;
  const basePrompt = (
    args.basePromptOverride ?? firstMessageTurnText(scenario)
  ).trim();
  const scenarioTags = scenario.tags ?? [];

  return PROMPT_BENCHMARK_VARIANTS.map((variant) => {
    const positiveCase = variant.shouldExecute;
    const caseId = `${scenario.id}__${variant.id}`;
    const expectedAction = positiveCase ? expectation.expectedAction : null;
    const optimizationTask = deriveOptimizationTask({
      expectedAction,
      scenario,
    });
    const riskClass =
      positiveCase && expectation.expectedAction === null
        ? "null"
        : variant.riskClass;
    const benchmarkWeight =
      positiveCase && expectation.expectedAction === null
        ? Math.max(variant.benchmarkWeight, 2)
        : variant.benchmarkWeight;
    const acceptableActions = positiveCase
      ? [...(expectation.acceptableActions ?? [])]
      : ["REPLY"];
    const forbiddenActions = positiveCase
      ? expectation.expectedAction === null
        ? [...(expectation.forbiddenActions ?? [])]
        : []
      : uniqueStrings([
          expectation.expectedAction,
          ...(expectation.acceptableActions ?? []),
          ...(expectation.forbiddenActions ?? []),
        ]);

    return {
      caseId,
      suiteId,
      baseScenarioId: scenario.id,
      scenarioTitle: scenario.title,
      domain: scenario.domain,
      basePrompt,
      prompt: variant.rewrite(basePrompt),
      benchmarkContext: buildPromptBenchmarkContext({
        scenarioTitle: scenario.title,
        expectedAction,
      }),
      optimizationTask,
      variantId: variant.id,
      variantLabel: variant.label,
      axes: [...variant.axes],
      riskClass,
      benchmarkWeight,
      expectedAction,
      acceptableActions,
      forbiddenActions,
      expectedOperation: positiveCase
        ? (expectation.expectedOperation ?? null)
        : null,
      tags: uniqueStrings([
        suiteId,
        scenario.domain,
        optimizationTask,
        variant.id,
        riskClass,
        ...scenarioTags,
      ]),
      notes:
        expectation.notes ??
        (variant.id === "subtle-null"
          ? "Subtle non-request: reply conversationally and avoid executing the base scenario action."
          : undefined),
    };
  });
}

function buildCapabilityCoverageCases(): PromptBenchmarkCase[] {
  const cases: Array<{
    task: LifeOpsPromptBenchmarkTask;
    prompt: string;
    expectedAction: string;
    acceptableActions?: string[];
    expectedOperation?: string | null;
  }> = [
    {
      task: "calendar_extract",
      prompt: "Put dentist on my calendar tomorrow at 3pm.",
      expectedAction: "CALENDAR",
    },
    {
      task: "schedule_plan",
      prompt:
        "Start a scheduling negotiation with Mia for a 30 minute review next week.",
      expectedAction: "PERSONAL_ASSISTANT",
      expectedOperation: "scheduling",
      acceptableActions: ["CALENDAR"],
    },
    {
      task: "reminder_dispatch",
      prompt: "Remind me every weekday at 3pm to take my medication.",
      expectedAction: "OWNER_REMINDERS",
      acceptableActions: ["LIFE"],
    },
    {
      task: "inbox_triage",
      prompt:
        "Find the vendor renewal invoice email and tell me if it needs a reply.",
      expectedAction: "MESSAGE",
      acceptableActions: ["INBOX"],
    },
    {
      task: "meeting_prep",
      prompt: "Give me the dossier for my next meeting.",
      expectedAction: "BRIEF",
      acceptableActions: ["CALENDAR", "PERSONAL_ASSISTANT"],
    },
    {
      task: "morning_brief",
      prompt: "What's on my plate today? Give me the brief.",
      expectedAction: "BRIEF",
    },
    {
      task: "health_checkin",
      prompt: "Check my sleep and activity signals for recovery risk today.",
      expectedAction: "OWNER_HEALTH",
    },
    {
      task: "screentime_recap",
      prompt:
        "Summarize my screen-time pattern and suggest one focus adjustment.",
      expectedAction: "OWNER_SCREENTIME",
    },
  ];

  return cases.map((testCase) => ({
    caseId: `lifeops-capability.${testCase.task}__direct`,
    suiteId: "lifeops-capability-coverage",
    baseScenarioId: `lifeops-capability.${testCase.task}`,
    scenarioTitle: `LifeOps capability coverage: ${testCase.task}`,
    domain: "lifeops",
    basePrompt: testCase.prompt,
    prompt: testCase.prompt,
    benchmarkContext: buildPromptBenchmarkContext({
      scenarioTitle: `LifeOps capability coverage: ${testCase.task}`,
      expectedAction: testCase.expectedAction,
    }),
    optimizationTask: testCase.task,
    variantId: "direct",
    variantLabel: "Direct",
    axes: ["baseline", "direct", "lifeops-capability"],
    riskClass: "positive",
    benchmarkWeight: 1,
    expectedAction: testCase.expectedAction,
    acceptableActions: [...(testCase.acceptableActions ?? [])],
    forbiddenActions: [],
    expectedOperation: testCase.expectedOperation ?? null,
    tags: [
      "lifeops-capability-coverage",
      "lifeops",
      testCase.task,
      "direct",
      "positive",
    ],
  }));
}

function firstStringLiteral(source: string, property: string): string {
  const pattern = new RegExp(`${property}:\\s*(['"\`])([\\s\\S]*?)\\1`, "u");
  return source.match(pattern)?.[2]?.trim() ?? "";
}

function stringArrayLiteral(source: string, property: string): string[] {
  const pattern = new RegExp(`${property}:\\s*\\[([\\s\\S]*?)\\]`, "u");
  const body = source.match(pattern)?.[1] ?? "";
  const values: string[] = [];
  const stringPattern = /(['"`])([\s\S]*?)\1/gu;
  for (const match of body.matchAll(stringPattern)) {
    const value = match[2]?.trim();
    if (value) values.push(value);
  }
  return values;
}

function allTurnTexts(source: string): ScenarioTurnLike[] {
  const turns: ScenarioTurnLike[] = [];
  const textPattern = /\btext:\s*(['"`])([\s\S]*?)\1/gu;
  for (const match of source.matchAll(textPattern)) {
    const text = match[2]?.trim();
    if (text) turns.push({ kind: "message", text });
  }
  return turns;
}

function selectedActionChecks(source: string): ScenarioFinalCheckLike[] {
  const checks: ScenarioFinalCheckLike[] = [];
  if (/\btype:\s*(['"])goalCountDelta\1/u.test(source)) {
    checks.push({ type: "goalCountDelta" });
  }

  const actionPattern = /\bactionName:\s*(\[[\s\S]*?\]|(['"`])([\s\S]*?)\2)/gu;
  for (const match of source.matchAll(actionPattern)) {
    const raw = match[1] ?? "";
    const actionName = raw.startsWith("[")
      ? stringArrayLiteral(`actionName: ${raw}`, "actionName")
      : (match[3]?.trim() ?? "");
    if (Array.isArray(actionName) ? actionName.length > 0 : actionName) {
      checks.push({ type: "selectedAction", actionName });
    }
  }
  return checks;
}

async function loadScenarioModule(filePath: string): Promise<ScenarioLike> {
  const source = await readFile(filePath, "utf8");
  const id = firstStringLiteral(source, "id");
  const title = firstStringLiteral(source, "title");
  const domain = firstStringLiteral(source, "domain");
  if (!id || !title || !domain) {
    throw new Error(
      `Scenario "${filePath}" is missing static id/title/domain metadata.`,
    );
  }
  return {
    id,
    title,
    domain,
    tags: stringArrayLiteral(source, "tags"),
    turns: allTurnTexts(source),
    finalChecks: selectedActionChecks(source),
  };
}

async function loadScenarioFromDirectory(args: {
  directory: string;
  id: string;
}): Promise<ScenarioLike> {
  return loadScenarioModule(
    path.join(args.directory, `${args.id}.scenario.ts`),
  );
}

export async function loadExecutiveAssistantCatalog(): Promise<ExecutiveAssistantCatalog> {
  const raw = await readFile(EXECUTIVE_ASSISTANT_CATALOG_PATH, "utf8");
  return JSON.parse(raw) as ExecutiveAssistantCatalog;
}

export async function loadExecutiveAssistantScenarios(): Promise<
  ScenarioLike[]
> {
  const catalog = await loadExecutiveAssistantCatalog();
  const landedEntries = catalog.scenarios.filter((entry) =>
    existsSync(
      path.join(EXECUTIVE_ASSISTANT_SCENARIO_DIR, `${entry.id}.scenario.ts`),
    ),
  );
  if (landedEntries.length === 0) {
    throw new Error(
      `No executable executive-assistant scenarios found under ${EXECUTIVE_ASSISTANT_SCENARIO_DIR}.`,
    );
  }
  return Promise.all(
    landedEntries.map((entry) =>
      loadScenarioFromDirectory({
        directory: EXECUTIVE_ASSISTANT_SCENARIO_DIR,
        id: entry.id,
      }),
    ),
  );
}

export async function loadSelfCareScenarios(): Promise<ScenarioLike[]> {
  const prdScenarios = await Promise.all(
    SELF_CARE_PRD_SCENARIO_IDS.map((id) =>
      loadScenarioFromDirectory({
        directory: SELF_CARE_SCENARIO_DIR,
        id,
      }),
    ),
  );
  const habitScenarios = await Promise.all(
    SELF_CARE_HABIT_SCENARIO_IDS.map((id) =>
      loadScenarioFromDirectory({
        directory: SELF_CARE_HABIT_SCENARIO_DIR,
        id,
      }),
    ),
  );
  return [...prdScenarios, ...habitScenarios];
}

export async function buildExecutiveAssistantPromptBenchmarkCases(): Promise<
  PromptBenchmarkCase[]
> {
  const [catalog, scenarios] = await Promise.all([
    loadExecutiveAssistantCatalog(),
    loadExecutiveAssistantScenarios(),
  ]);
  const promptsByScenarioId = new Map(
    catalog.scenarios.map((entry) => [entry.id, entry.benchmarkPrompt]),
  );
  return scenarios.flatMap((scenario) =>
    buildPromptBenchmarkCasesForScenario({
      basePromptOverride: promptsByScenarioId.get(scenario.id) ?? undefined,
      expectation: deriveExecutiveAssistantExpectation(scenario),
      scenario,
      suiteId: "lifeops-executive-assistant",
    }),
  );
}

export async function buildSelfCarePromptBenchmarkCases(): Promise<
  PromptBenchmarkCase[]
> {
  const scenarios = await loadSelfCareScenarios();
  return scenarios.flatMap((scenario) =>
    buildPromptBenchmarkCasesForScenario({
      expectation: deriveSelfCareExpectation(scenario),
      scenario,
      suiteId: "lifeops-self-care",
    }),
  );
}

export async function buildLifeOpsPromptBenchmarkCases(): Promise<
  PromptBenchmarkCase[]
> {
  const [selfCareCases, executiveAssistantCases] = await Promise.all([
    buildSelfCarePromptBenchmarkCases(),
    buildExecutiveAssistantPromptBenchmarkCases(),
  ]);
  return [
    ...buildCapabilityCoverageCases(),
    ...selfCareCases,
    ...executiveAssistantCases,
  ];
}

export function getPromptBenchmarkVariantDefinitions(): readonly PromptVariantDefinition[] {
  return PROMPT_BENCHMARK_VARIANTS;
}
