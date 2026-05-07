import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import {
  ModelType,
  parseToonKeyValue,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { getRecentMessagesData } from "@elizaos/shared";
import { runExtractorPipeline } from "../extractor-pipeline.js";
import { resolveContextWindow } from "../lifeops-extraction-config.js";

export const LIFE_OPERATION_VALUES = [
  "create",
  "update",
  "delete",
  "complete",
  "skip",
  "snooze",
  "review",
  "query_calendar_today",
  "query_calendar_next",
  "query_email",
  "query_overview",
] as const;

export type ExtractedLifeOperation = (typeof LIFE_OPERATION_VALUES)[number];
export type ExtractedLifeMissingField =
  | "title"
  | "schedule"
  | "target"
  | "goal"
  | "details";

type ExtractedLifeOperationPlan = {
  operation: ExtractedLifeOperation | null;
  confidence: number;
  missing: ExtractedLifeMissingField[];
  shouldAct: boolean;
};

type CoreLifeOperation =
  | "create"
  | "complete"
  | "snooze"
  | "query_overview"
  | null;

function messageText(message: Memory): string {
  const text = message.content?.text;
  return typeof text === "string" ? text.trim() : "";
}

function splitStateTextCandidates(value: string): string[] {
  return value
    .split(/\n+/)
    .map((line) =>
      line
        .replace(
          /^[a-zA-Z\u00C0-\u024F\u0400-\u04FF\u3000-\u9FFF]{1,20}\s*:\s*/,
          "",
        )
        .trim(),
    )
    .filter((line) => line.length > 0);
}

function stateTextCandidates(state: State | undefined): string[] {
  if (!state || typeof state !== "object") {
    return [];
  }

  const stateRecord = state as Record<string, unknown>;
  const values =
    stateRecord.values && typeof stateRecord.values === "object"
      ? (stateRecord.values as Record<string, unknown>)
      : undefined;

  const candidates: string[] = [];
  const pushText = (value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) {
      candidates.push(...splitStateTextCandidates(value));
    }
  };

  pushText(values?.recentMessages);
  pushText(stateRecord.text);

  for (const item of getRecentMessagesData(state)) {
    const content = item.content;
    if (!content || typeof content !== "object") {
      continue;
    }
    pushText(content.text);
  }

  return [...new Set(candidates)];
}

function normalizeOperation(value: unknown): ExtractedLifeOperation | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return LIFE_OPERATION_VALUES.includes(normalized as ExtractedLifeOperation)
    ? (normalized as ExtractedLifeOperation)
    : null;
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }
  return null;
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return null;
}

const VALID_MISSING_FIELDS = new Set<ExtractedLifeMissingField>([
  "title",
  "schedule",
  "target",
  "goal",
  "details",
]);

function normalizeMissingFields(value: unknown): ExtractedLifeMissingField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const missing: ExtractedLifeMissingField[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = item.trim().toLowerCase() as ExtractedLifeMissingField;
    if (VALID_MISSING_FIELDS.has(normalized) && !missing.includes(normalized)) {
      missing.push(normalized);
    }
  }
  return missing;
}

const REPLY_ONLY_OPERATION_PLAN: ExtractedLifeOperationPlan = {
  operation: null,
  confidence: 0,
  missing: [],
  shouldAct: false,
};

function promptText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "(empty)";
}

function normalizeOperationPlan(
  parsed: Record<string, unknown>,
): ExtractedLifeOperationPlan | null {
  const operation = normalizeOperation(parsed.operation);
  const missing = normalizeMissingFields(parsed.missing);
  const shouldAct =
    normalizeShouldAct(parsed.shouldAct) ??
    (operation ? missing.length === 0 : null);
  if (shouldAct === null) {
    return null;
  }

  // Acting without a concrete operation is invalid; keep the plan reply-only.
  if (shouldAct && operation === null) {
    return null;
  }

  return {
    operation,
    confidence: normalizeConfidence(parsed.confidence) ?? 0,
    missing,
    shouldAct,
  };
}

function buildRepairPrompt(args: {
  currentMessage: string;
  intent: string;
  rawResponse: string;
  recentConversation: string[];
}): string {
  return [
    "Your last reply for the LifeOps operation planner was invalid.",
    "Return ONLY a TOON record with exactly these fields:",
    "  operation: one of the allowed operations, or null when this should be reply-only/no-op",
    "  confidence: number from 0 to 1",
    "  shouldAct: boolean",
    "  missing: list of missing fields from title, schedule, target, goal, phone_number, reminder_intensity, details",
    "",
    "Do not add prose, markdown, code fences, or any other format.",
    "",
    `Allowed operations: ${LIFE_OPERATION_VALUES.join(", ")}, or null`,
    `Current request: ${promptText(args.currentMessage)}`,
    `Resolved intent: ${promptText(args.intent)}`,
    "Recent conversation:",
    promptText(args.recentConversation.join("\n")),
    "Previous invalid output:",
    promptText(args.rawResponse),
  ].join("\n");
}

function normalizeCoreLifeOperation(value: unknown): CoreLifeOperation {
  switch (value) {
    case "create":
    case "complete":
    case "snooze":
    case "query_overview":
      return value;
    default:
      return null;
  }
}

function normalizeCoreLifeOperationPlan(
  parsed: Record<string, unknown>,
): ExtractedLifeOperationPlan | null {
  const operation = normalizeCoreLifeOperation(parsed.operation);
  const missing = normalizeMissingFields(parsed.missing);
  const shouldAct =
    normalizeShouldAct(parsed.shouldAct) ??
    (operation ? missing.length === 0 : null);
  if (shouldAct === null) {
    return null;
  }

  if (shouldAct && operation === null) {
    return null;
  }

  return {
    operation,
    confidence: normalizeConfidence(parsed.confidence) ?? 0,
    missing,
    shouldAct,
  };
}

async function recoverCoreLifeOperationWithLlm(args: {
  runtime: IAgentRuntime;
  currentMessage: string;
  intent: string;
  recentConversation: string[];
}): Promise<ExtractedLifeOperationPlan | null> {
  const prompt = [
    "Recover the core LifeOps intent for this request.",
    "The user may speak in any language.",
    "Choose the closest operation from: create, complete, snooze, query_overview, or null.",
    "create is for creating a reminder, alarm, routine, recurring task, or goal.",
    "complete is for saying the user already did something.",
    "snooze is for deferring or postponing something to later.",
    "query_overview is for asking what is still left, active, or remaining today.",
    "Use null only when the request is casual chat or not a core LifeOps action.",
    "",
    "Return ONLY a TOON record with exactly these fields:",
    "  operation: create, complete, snooze, query_overview, or null",
    "  confidence: number from 0 to 1",
    "  shouldAct: boolean",
    "  missing: list of missing fields from title, schedule, target, goal, details",
    "",
    "Examples:",
    '  Input: "remind me to brush my teeth every night"',
    "  operation: create",
    "  confidence: 0.95",
    "  shouldAct: true",
    "  missing: []",
    '  Input: "Je viens de me brosser les dents"',
    "  operation: complete",
    "  confidence: 0.95",
    "  shouldAct: true",
    "  missing: []",
    '  Input: "remind me later"',
    "  operation: snooze",
    "  confidence: 0.9",
    "  shouldAct: true",
    "  missing: []",
    '  Input: "¿Qué me queda por hacer hoy?"',
    "  operation: query_overview",
    "  confidence: 0.88",
    "  shouldAct: true",
    "  missing: []",
    '  Input: "yeah lol"',
    "  operation: null",
    "  confidence: 0.6",
    "  shouldAct: false",
    "  missing: []",
    "",
    `Current request: ${promptText(args.currentMessage)}`,
    `Resolved intent: ${promptText(args.intent)}`,
    "Recent conversation:",
    promptText(args.recentConversation.join("\n")),
  ].join("\n");

  try {
    const result = await runWithTrajectoryContext(
      { purpose: "lifeops-extract-life-operation" },
      () =>
        args.runtime.useModel(ModelType.TEXT_LARGE, {
          prompt,
        }),
    );
    const rawResponse = typeof result === "string" ? result : "";
    const parsed = parseToonKeyValue<Record<string, unknown>>(rawResponse);
    return parsed ? normalizeCoreLifeOperationPlan(parsed) : null;
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:life",
        error: error instanceof Error ? error.message : String(error),
      },
      "Core LifeOps recovery model call failed",
    );
    return null;
  }
}

export async function extractLifeOperationWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
}): Promise<ExtractedLifeOperationPlan> {
  const { runtime, message, state, intent } = args;
  const recentConversation = stateTextCandidates(state).slice(
    -resolveContextWindow(),
  );
  const currentMessage = messageText(message);
  const prompt = [
    "Plan the LifeOps response for the current user request.",
    "The user may speak in any language.",
    "Use the current request plus recent conversation context.",
    "Short follow-ups can continue an earlier alarm or reminder request when that context appears in the recent conversation.",
    "You are allowed to decide that the assistant should reply naturally without acting yet.",
    "Set shouldAct=false when the user is chatting, acknowledging, brainstorming, or asking for help in a way that is too vague to safely create, update, complete, or query anything yet.",
    "When the user clearly wants a LifeOps action but key information is missing, set operation to the closest operation, shouldAct=false, and list the blocking pieces in missing.",
    "Only set shouldAct=true when the assistant should execute, preview, update, or query right now.",
    "Requests with concrete routine content and interpretable cadence are actionable even when some fields are implied.",
    "Treat requests like weekdays after lunch, during the day, every morning, tomorrow at 9, set an alarm for 7 am, and remind me about my Invisalign as specific enough to act on now.",
    "A goal horizon like this year, this month, by June, or before my trip does not create a routine cadence by itself.",
    "Use create with a goal-flavored intent for aspirations with a target or horizon unless the user explicitly asks for reminders, recurrence, or a routine schedule.",
    "",
    "Return a TOON record with exactly these fields:",
    "  operation: one of the allowed operations below, or null when this should be reply-only/no-op",
    "  confidence: number from 0 to 1",
    "  shouldAct: boolean",
    "  missing: list of missing fields from title, schedule, target, goal, details",
    "",
    "Operations and when to use each:",
    "  create — create a new habit, routine, task, one-off alarm, reminder, or aspirational goal (e.g. 'remind me to brush my teeth every night', 'set an alarm for 7am', 'I want to run a marathon')",
    "  update — edit, rename, reschedule, or modify an existing task/habit/routine/goal (e.g. 'change my workout to 6am', 'update my marathon goal to June')",
    "  delete — delete, remove, cancel, or stop tracking a task/habit/routine/goal (e.g. 'stop tracking my meditation', 'delete my marathon goal')",
    "  complete — mark an item as done (e.g. 'I brushed my teeth', 'done with workout', 'I did it')",
    "  skip — skip an item for today (e.g. 'skip brushing', 'not today', 'pass on workout')",
    "  snooze — postpone or defer an item (e.g. 'snooze', 'remind me later', 'push it back')",
    "  review — check progress on a goal or ask for a weekly goal review (e.g. 'how am I doing on my marathon goal', 'review my progress')",
    "  query_calendar_today — today's/tomorrow's/this week's schedule (e.g. 'what's on my calendar today')",
    "  query_calendar_next — next upcoming event (e.g. 'what's my next meeting')",
    "  query_email — inbox/email status (e.g. 'any new emails', 'who emailed me')",
    "  query_overview — broad status summary or remaining LifeOps items (e.g. 'what's active', 'show me everything', 'overview', \"what's still left for today\", 'what do i still need to do today')",
    "",
    "Examples:",
    '  Input: "I brushed my teeth"',
    "  operation: complete",
    "  confidence: 0.95",
    "  shouldAct: true",
    "  missing: []",
    '  Input: "remind me to take vitamins every morning"',
    "  operation: create",
    "  confidence: 0.95",
    "  shouldAct: true",
    "  missing: []",
    '  Input: "I want to learn guitar this year"',
    "  operation: create",
    "  confidence: 0.9",
    "  shouldAct: true",
    "  missing: []",
    '  Input: "what\'s still left for today"',
    "  operation: query_overview",
    "  confidence: 0.88",
    "  shouldAct: true",
    "  missing: []",
    '  Input: "lol yeah. can you help me add a todo for my life?"',
    "  operation: create",
    "  confidence: 0.82",
    "  shouldAct: false",
    "  missing: [title, schedule]",
    '  Input: "yeah lol"',
    "  operation: null",
    "  confidence: 0.62",
    "  shouldAct: false",
    "  missing: []",
    "",
    "Return ONLY valid TOON. No prose. No markdown. No code fences. No <think>.",
    "",
    `Allowed operations: ${LIFE_OPERATION_VALUES.join(", ")}, or null`,
    `Current request: ${promptText(currentMessage)}`,
    `Resolved intent: ${promptText(intent)}`,
    "Recent conversation:",
    promptText(recentConversation.join("\n")),
  ].join("\n");

  const parseResponse = (rawResponse: string) => {
    const parsed = parseToonKeyValue<Record<string, unknown>>(rawResponse);
    return parsed ? normalizeOperationPlan(parsed) : null;
  };

  const { parsed: pipelinePlan } = await runExtractorPipeline({
    runtime,
    prompt,
    parser: parseResponse,
    buildRepairPrompt: (rawFirstPass) =>
      buildRepairPrompt({
        currentMessage,
        intent,
        rawResponse: rawFirstPass,
        recentConversation,
      }),
  });

  if (pipelinePlan && pipelinePlan.operation !== null) {
    return pipelinePlan;
  }

  const recoveredPlan = await recoverCoreLifeOperationWithLlm({
    runtime,
    currentMessage,
    intent,
    recentConversation,
  });
  return recoveredPlan ?? pipelinePlan ?? REPLY_ONLY_OPERATION_PLAN;
}
