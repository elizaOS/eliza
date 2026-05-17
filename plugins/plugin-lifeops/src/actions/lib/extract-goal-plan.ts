import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import type {
  CreateLifeOpsGoalRequest,
  LifeOpsGoalDefinition,
  UpdateLifeOpsGoalRequest,
} from "../../contracts/index.js";
import {
  buildGoalGroundingMetadata,
  GOAL_GROUNDING_STATES,
  type GoalGroundingMetadata,
  type GoalGroundingState,
  mergeGoalGroundingMetadata,
} from "../../lifeops/goal-grounding.js";
import { runExtractorPipeline } from "../../lifeops/llm/extractor-pipeline.js";
import { parseJsonModelRecord } from "../../utils/json-model-output.js";
import { recentConversationTexts } from "./recent-context.js";

export const GOAL_GROUNDING_FIELD_VALUES = [
  "title",
  "target_state",
  "success_metric",
  "time_horizon",
  "evidence_source",
  "support_plan",
] as const;

export type GoalGroundingField = (typeof GOAL_GROUNDING_FIELD_VALUES)[number];

export interface ExtractedGoalCreatePlan {
  mode: "create" | "respond";
  response: string | null;
  title: string | null;
  description: string | null;
  cadence: CreateLifeOpsGoalRequest["cadence"];
  successCriteria: CreateLifeOpsGoalRequest["successCriteria"] | null;
  supportStrategy: CreateLifeOpsGoalRequest["supportStrategy"] | null;
  groundingState: GoalGroundingState;
  missingCriticalFields: GoalGroundingField[];
  confidence: number | null;
  evaluationSummary: string | null;
  targetDomain: string | null;
}

export interface ExtractedGoalUpdatePlan {
  mode: "update" | "respond";
  response: string | null;
  title: string | null;
  description: string | null;
  cadence: UpdateLifeOpsGoalRequest["cadence"];
  successCriteria: UpdateLifeOpsGoalRequest["successCriteria"] | null;
  supportStrategy: UpdateLifeOpsGoalRequest["supportStrategy"] | null;
  groundingState: GoalGroundingState | null;
  missingCriticalFields: GoalGroundingField[];
  confidence: number | null;
  evaluationSummary: string | null;
  targetDomain: string | null;
}

const VALID_CREATE_MODES = new Set(["create", "respond"]);
const VALID_UPDATE_MODES = new Set(["update", "respond"]);
const EMPTY_GOAL_CREATE_PLAN: ExtractedGoalCreatePlan = {
  mode: "respond",
  response:
    "What would count as success for that goal, and over what time window?",
  title: null,
  description: null,
  cadence: null,
  successCriteria: null,
  supportStrategy: null,
  groundingState: "ungrounded",
  missingCriticalFields: [
    "target_state",
    "success_metric",
    "time_horizon",
    "evidence_source",
  ],
  confidence: null,
  evaluationSummary: null,
  targetDomain: null,
};

const DEFAULT_PARTIAL_GOAL_MISSING_FIELDS: GoalGroundingField[] = [
  "target_state",
  "success_metric",
  "time_horizon",
  "evidence_source",
  "support_plan",
];

const EMPTY_GOAL_UPDATE_PLAN: ExtractedGoalUpdatePlan = {
  mode: "respond",
  response: "Tell me what to change about the goal.",
  title: null,
  description: null,
  cadence: null,
  successCriteria: null,
  supportStrategy: null,
  groundingState: null,
  missingCriticalFields: [],
  confidence: null,
  evaluationSummary: null,
  targetDomain: null,
};

function promptText(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : "(empty)";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => promptText(entry)).join(", ")}]`;
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}: ${promptText(entry)}`)
      .join("\n");
  }
  return String(value);
}

function parseStructuredRecord(raw: string): Record<string, unknown> | null {
  return parseJsonModelRecord<Record<string, unknown>>(raw);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeEvidenceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function extractEvidenceTokens(value: string): string[] {
  const tokens = normalizeEvidenceText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3);
  return [...new Set(tokens)];
}

function intentProvidesGoalTitleEvidence(
  intent: string,
  title: string,
): boolean {
  const normalizedIntent = normalizeEvidenceText(intent);
  const normalizedTitle = normalizeEvidenceText(title);
  if (!normalizedIntent || !normalizedTitle) {
    return false;
  }
  if (
    normalizedIntent.includes(normalizedTitle) ||
    normalizedTitle.includes(normalizedIntent)
  ) {
    return true;
  }
  const titleTokens = extractEvidenceTokens(title);
  return (
    titleTokens.length > 0 &&
    titleTokens.every((token) => normalizedIntent.includes(token))
  );
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeMissingFields(value: unknown): GoalGroundingField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const missing: GoalGroundingField[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim().toLowerCase() as GoalGroundingField;
    if (
      GOAL_GROUNDING_FIELD_VALUES.includes(normalized) &&
      !missing.includes(normalized)
    ) {
      missing.push(normalized);
    }
  }
  return missing;
}

function normalizeGroundingState(value: unknown): GoalGroundingState | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return GOAL_GROUNDING_STATES.includes(normalized as GoalGroundingState)
    ? (normalized as GoalGroundingState)
    : null;
}

function normalizeCreateMode(
  value: unknown,
): ExtractedGoalCreatePlan["mode"] | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return VALID_CREATE_MODES.has(normalized)
    ? (normalized as ExtractedGoalCreatePlan["mode"])
    : null;
}

function normalizeUpdateMode(
  value: unknown,
): ExtractedGoalUpdatePlan["mode"] | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return VALID_UPDATE_MODES.has(normalized)
    ? (normalized as ExtractedGoalUpdatePlan["mode"])
    : null;
}

function buildCreatePlan(
  parsed: Record<string, unknown>,
): ExtractedGoalCreatePlan | null {
  const mode = normalizeCreateMode(parsed.mode);
  const groundingState = normalizeGroundingState(parsed.groundingState);
  if (!mode || !groundingState) {
    return null;
  }
  return {
    mode,
    response: mode === "respond" ? normalizeText(parsed.response) : null,
    title: normalizeText(parsed.title),
    description: normalizeText(parsed.description),
    cadence: normalizeRecord(parsed.cadence),
    successCriteria: normalizeRecord(parsed.successCriteria),
    supportStrategy: normalizeRecord(parsed.supportStrategy),
    groundingState,
    missingCriticalFields: normalizeMissingFields(parsed.missingCriticalFields),
    confidence: normalizeFiniteNumber(parsed.confidence),
    evaluationSummary: normalizeText(parsed.evaluationSummary),
    targetDomain: normalizeText(parsed.targetDomain),
  };
}

function stabilizeCreatePlan(
  plan: ExtractedGoalCreatePlan,
  intent: string,
): ExtractedGoalCreatePlan {
  if (plan.mode !== "respond" || plan.groundingState !== "ungrounded") {
    return plan;
  }
  if (!plan.title || !intentProvidesGoalTitleEvidence(intent, plan.title)) {
    return plan;
  }

  const missingCriticalFields = plan.missingCriticalFields.filter(
    (field) => field !== "title",
  );

  return {
    ...plan,
    groundingState: "partial",
    missingCriticalFields:
      missingCriticalFields.length > 0
        ? missingCriticalFields
        : [...DEFAULT_PARTIAL_GOAL_MISSING_FIELDS],
  };
}

function buildUpdatePlan(
  parsed: Record<string, unknown>,
): ExtractedGoalUpdatePlan | null {
  const mode = normalizeUpdateMode(parsed.mode);
  if (!mode) {
    return null;
  }
  return {
    mode,
    response: mode === "respond" ? normalizeText(parsed.response) : null,
    title: normalizeText(parsed.title),
    description: normalizeText(parsed.description),
    cadence: normalizeRecord(parsed.cadence),
    successCriteria: normalizeRecord(parsed.successCriteria),
    supportStrategy: normalizeRecord(parsed.supportStrategy),
    groundingState: normalizeGroundingState(parsed.groundingState),
    missingCriticalFields: normalizeMissingFields(parsed.missingCriticalFields),
    confidence: normalizeFiniteNumber(parsed.confidence),
    evaluationSummary: normalizeText(parsed.evaluationSummary),
    targetDomain: normalizeText(parsed.targetDomain),
  };
}

export function buildGoalCreateExtractionPrompt(
  intent: string,
  recentConversation: string,
): string {
  return [
    "Ground the user's goal into something the system can actually review later.",
    "The user may speak in any language and may refer to a previous goal draft or clarification exchange.",
    "A goal is only ready to save when future progress can be evaluated from evidence.",
    "Do not treat a label-only aspiration as ready just because it has a nice title.",
    "",
    "CRITICAL GROUNDING RULE:",
    "  If the user names ANY goal, aspiration, outcome, or desire (even one line like 'I want X' or 'help me with X'), the groundingState is AT LEAST 'partial' — never 'ungrounded'. Always extract that phrase into the title field.",
    "  Use 'ungrounded' ONLY for empty/vacuous inputs like 'help', 'hi', 'can you make a goal', where the user has NOT named anything to work on.",
    "A grounded goal usually includes:",
    "- the target state or outcome",
    "- what success would look like",
    "- the time horizon or review window",
    "- the evidence signals or metrics that can show progress",
    "- a concrete support strategy",
    "",
    "Return ONLY valid JSON with these fields:",
    '- mode: "create" when the goal is grounded enough to save now, otherwise "respond"',
    "- response: one focused clarifying question when mode=respond, otherwise null",
    "- title: concise goal title",
    "- description: short human-readable description",
    "- cadence: optional review cadence record, usually kind: weekly or kind: monthly",
    "- successCriteria: structured record describing how progress or success will be judged",
    "- supportStrategy: structured record describing how the goal should be supported",
    '- groundingState: one of "grounded", "partial", "ungrounded"',
    "- missingCriticalFields: list drawn only from title, target_state, success_metric, time_horizon, evidence_source, support_plan",
    "- confidence: number from 0 to 1",
    "- evaluationSummary: one sentence describing what would count as progress",
    "- targetDomain: short domain label like sleep, fitness, work, learning, finances, relationships, health, creativity",
    "",
    "Important rules:",
    "- If the user only gives a title or vague aspiration, choose mode=respond.",
    "- Any user-provided goal title or clear aspiration counts as partial grounding, not ungrounded.",
    "- Use groundingState=ungrounded only when the user has not provided a usable goal title, aspiration, or target at all.",
    "- Ask for the single most important missing piece, not a questionnaire.",
    "- successCriteria and supportStrategy must be structured records, not strings or lists.",
    "- Encode measurable or observable criteria whenever possible.",
    "- If sleep, routines, biometrics, calendar, or linked habits are relevant evidence, name them explicitly in successCriteria.",
    "",
    "Examples:",
    'Input: "I want a goal called Stabilize sleep schedule."',
    "mode: respond",
    "response: What would a stabilized sleep schedule look like for you: target bedtime and wake time, or a consistency window?",
    "title: Stabilize sleep schedule",
    "description: Build a more consistent sleep schedule.",
    "cadence:",
    "  kind: weekly",
    "successCriteria: null",
    "supportStrategy: null",
    "groundingState: partial",
    "missingCriticalFields: [target_state, success_metric, time_horizon, evidence_source, support_plan]",
    "confidence: 0.78",
    "evaluationSummary: null",
    "targetDomain: sleep",
    "",
    'Input: "I want to get better sleep."',
    "mode: respond",
    "response: What would better sleep look like for you: target bedtime, wake time, sleep duration, or consistency?",
    "title: Improve sleep",
    "description: Sleep more consistently and wake up feeling rested.",
    "cadence:",
    "  kind: weekly",
    "successCriteria: null",
    "supportStrategy: null",
    "groundingState: partial",
    "missingCriticalFields: [target_state, success_metric, time_horizon, evidence_source, support_plan]",
    "confidence: 0.74",
    "evaluationSummary: null",
    "targetDomain: sleep",
    "",
    'Input: "Can you help me make a goal?"',
    "mode: respond",
    "response: What goal do you want to work on?",
    "title: null",
    "description: null",
    "cadence: null",
    "successCriteria: null",
    "supportStrategy: null",
    "groundingState: ungrounded",
    "missingCriticalFields: [title, target_state, success_metric, time_horizon, evidence_source, support_plan]",
    "confidence: 0.56",
    "evaluationSummary: null",
    "targetDomain: null",
    "",
    'Input: "I want to stabilize my sleep schedule by being asleep by 11:30 pm and up around 7:30 am on weekdays, within 45 minutes, for the next month."',
    "mode: create",
    "response: null",
    "title: Stabilize sleep schedule",
    "description: Keep weekday sleep and wake times consistent for the next month.",
    "cadence:",
    "  kind: weekly",
    "  reviewWindowDays: 7",
    "successCriteria:",
    "  summary: For the next 30 days, be asleep by about 11:30 pm and awake by about 7:30 am on weekdays, staying within 45 minutes on at least 20 days.",
    "  metric: weekday sleep schedule consistency",
    "  evidenceSignals: [health.sleep, manual_checkin]",
    "supportStrategy:",
    "  summary: Use a consistent wind-down and morning routine.",
    "  firstStep: Pick a wind-down start time 45 to 60 minutes before bed.",
    "  suggestedSupport: [evening wind-down routine, morning wake routine, weekly sleep check-in]",
    "groundingState: grounded",
    "missingCriticalFields: []",
    "confidence: 0.9",
    "evaluationSummary: Progress means weekday bed and wake times stay near 11:30 pm and 7:30 am over the next month.",
    "targetDomain: sleep",
    "",
    "Return ONLY valid JSON. No prose, markdown, code fences, or any other format.",
    "",
    `User request: ${promptText(intent)}`,
    "Recent conversation:",
    promptText(recentConversation),
  ].join("\n");
}

function buildGoalCreateRepairPrompt(args: {
  intent: string;
  recentConversation: string;
  rawResponse: string;
}): string {
  return [
    "Your last reply for the goal-grounding extractor was invalid.",
    "Return ONLY valid JSON with exactly these fields:",
    "mode, response, title, description, cadence, successCriteria, supportStrategy, groundingState, missingCriticalFields, confidence, evaluationSummary, targetDomain",
    "",
    'mode must be "create" or "respond".',
    'groundingState must be "grounded", "partial", or "ungrounded".',
    "successCriteria and supportStrategy must be structured records or null.",
    "missingCriticalFields must contain only valid enum values.",
    "",
    `User request: ${promptText(args.intent)}`,
    "Recent conversation:",
    promptText(args.recentConversation),
    "Previous invalid output:",
    promptText(args.rawResponse),
  ].join("\n");
}

export async function extractGoalCreatePlanWithLlm(args: {
  runtime: IAgentRuntime;
  intent: string;
  state: State | undefined;
  message?: Memory;
}): Promise<ExtractedGoalCreatePlan> {
  if (!args.intent.trim()) {
    return { ...EMPTY_GOAL_CREATE_PLAN };
  }
  const recentConversation = (
    await recentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 12,
    })
  ).join("\n");
  const prompt = buildGoalCreateExtractionPrompt(
    args.intent,
    recentConversation,
  );

  const { parsed } = await runExtractorPipeline({
    runtime: args.runtime,
    prompt,
    parser: (raw) => {
      const parsedObject = parseStructuredRecord(raw);
      return parsedObject ? buildCreatePlan(parsedObject) : null;
    },
    buildRepairPrompt: (rawFirstPass) =>
      buildGoalCreateRepairPrompt({
        intent: args.intent,
        recentConversation,
        rawResponse: rawFirstPass,
      }),
  });

  return parsed
    ? stabilizeCreatePlan(parsed, args.intent)
    : { ...EMPTY_GOAL_CREATE_PLAN };
}

export function buildGoalUpdateExtractionPrompt(args: {
  currentGoal: LifeOpsGoalDefinition;
  intent: string;
  recentConversation: string;
}): string {
  return [
    "Extract only the goal fields the user wants to change.",
    "The current goal may already contain evaluation criteria. Preserve what the user did not ask to change.",
    "If the user clarifies how the goal should be evaluated, update successCriteria and supportStrategy.",
    "If the request is too vague to apply safely, choose mode=respond and ask one focused question.",
    "",
    "Return ONLY valid JSON with these fields:",
    '- mode: "update" or "respond"',
    "- response: short clarifying response when mode=respond, otherwise null",
    "- title: new title or null",
    "- description: new description or null",
    "- cadence: replacement review cadence record or null",
    "- successCriteria: replacement success criteria record or null",
    "- supportStrategy: replacement support strategy record or null",
    '- groundingState: "grounded", "partial", "ungrounded", or null when unchanged',
    "- missingCriticalFields: list drawn only from title, target_state, success_metric, time_horizon, evidence_source, support_plan",
    "- confidence: number from 0 to 1",
    "- evaluationSummary: one sentence describing the updated evaluation contract, or null",
    "- targetDomain: updated domain label or null",
    "",
    `Current goal title: ${promptText(args.currentGoal.title)}`,
    `Current goal description: ${promptText(args.currentGoal.description)}`,
    "Current goal cadence:",
    promptText(args.currentGoal.cadence),
    "Current success criteria:",
    promptText(args.currentGoal.successCriteria),
    "Current support strategy:",
    promptText(args.currentGoal.supportStrategy),
    `User request: ${promptText(args.intent)}`,
    "Recent conversation:",
    promptText(args.recentConversation),
  ].join("\n");
}

function buildGoalUpdateRepairPrompt(args: {
  currentGoal: LifeOpsGoalDefinition;
  intent: string;
  recentConversation: string;
  rawResponse: string;
}): string {
  return [
    "Your last reply for the goal-update extractor was invalid.",
    "Return ONLY valid JSON with exactly these fields:",
    "mode, response, title, description, cadence, successCriteria, supportStrategy, groundingState, missingCriticalFields, confidence, evaluationSummary, targetDomain",
    "",
    'mode must be "update" or "respond".',
    "",
    `Current goal title: ${promptText(args.currentGoal.title)}`,
    `User request: ${promptText(args.intent)}`,
    "Recent conversation:",
    promptText(args.recentConversation),
    "Previous invalid output:",
    promptText(args.rawResponse),
  ].join("\n");
}

export async function extractGoalUpdatePlanWithLlm(args: {
  runtime: IAgentRuntime;
  currentGoal: LifeOpsGoalDefinition;
  intent: string;
  state: State | undefined;
  message?: Memory;
}): Promise<ExtractedGoalUpdatePlan> {
  if (!args.intent.trim()) {
    return { ...EMPTY_GOAL_UPDATE_PLAN };
  }
  const recentConversation = (
    await recentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 12,
    })
  ).join("\n");
  const prompt = buildGoalUpdateExtractionPrompt({
    currentGoal: args.currentGoal,
    intent: args.intent,
    recentConversation,
  });

  const { parsed } = await runExtractorPipeline({
    runtime: args.runtime,
    prompt,
    parser: (raw) => {
      const parsedObject = parseStructuredRecord(raw);
      return parsedObject ? buildUpdatePlan(parsedObject) : null;
    },
    buildRepairPrompt: (rawFirstPass) =>
      buildGoalUpdateRepairPrompt({
        currentGoal: args.currentGoal,
        intent: args.intent,
        recentConversation,
        rawResponse: rawFirstPass,
      }),
  });

  return parsed ?? { ...EMPTY_GOAL_UPDATE_PLAN };
}

type GoalGroundingPlanInput = {
  cadence: Record<string, unknown> | null | undefined;
  confidence: number | null;
  evaluationSummary: string | null;
  groundingState: GoalGroundingState;
  missingCriticalFields: GoalGroundingField[];
  successCriteria: Record<string, unknown> | null | undefined;
  targetDomain: string | null;
};

export function planToGoalGroundingMetadata(
  plan: GoalGroundingPlanInput,
  nowIso: string,
): GoalGroundingMetadata {
  const successCriteriaRecord = normalizeRecord(plan.successCriteria);
  const evidenceSignals = Array.isArray(successCriteriaRecord?.evidenceSignals)
    ? successCriteriaRecord.evidenceSignals
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
  const cadenceRecord = normalizeRecord(plan.cadence);
  return buildGoalGroundingMetadata({
    confidence: plan.confidence,
    evidenceSignals,
    groundedAt: plan.groundingState === "grounded" ? nowIso : null,
    groundingState: plan.groundingState,
    missingCriticalFields: plan.missingCriticalFields,
    reviewCadenceKind: normalizeText(cadenceRecord?.kind),
    summary: plan.evaluationSummary,
    targetDomain: plan.targetDomain,
  });
}

export function mergeGoalMetadataWithGrounding(args: {
  metadata?: Record<string, unknown> | null;
  nowIso: string;
  plan: GoalGroundingPlanInput;
}): Record<string, unknown> {
  const metadata = args.metadata ?? {};
  return mergeGoalGroundingMetadata(
    metadata,
    planToGoalGroundingMetadata(args.plan, args.nowIso),
  );
}
