/**
 * LLM planning and structured extraction for LifeOps task creation.
 *
 * Performs a second LLM call (TEXT_LARGE) after operation classification
 * to decide whether the current create_definition request should:
 * 1. create or preview a LifeOps item now, or
 * 2. reply/clarify without creating anything yet.
 *
 * When creation is appropriate, the same response also extracts structured
 * fields — title, cadence, priority, time-of-day, etc. — from natural
 * language so life.ts can stay on an LLM-driven extraction path.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import {
  ModelType,
  parseToonKeyValue,
  runWithTrajectoryContext,
} from "@elizaos/core";
import {
  LIFEOPS_REMINDER_INTENSITIES,
  type LifeOpsReminderIntensity,
} from "../../contracts/index.js";
import { runExtractorPipeline } from "../extractor-pipeline.js";
import { recentConversationTexts } from "./recent-context.js";
import { resolveContextWindow } from "../lifeops-extraction-config.js";
import { normalizeExplicitTimeZoneToken } from "../timezone-normalization.js";

// ── Types ─────────────────────────────────────────────

export interface ExtractedTaskParams {
  requestKind: "alarm" | "reminder" | null;
  title: string | null;
  description: string | null;
  cadenceKind:
    | "once"
    | "daily"
    | "weekly"
    | "times_per_day"
    | "interval"
    | null;
  windows: string[] | null;
  weekdays: number[] | null;
  timeOfDay: string | null;
  timeZone: string | null;
  everyMinutes: number | null;
  timesPerDay: number | null;
  priority: number | null;
  durationMinutes: number | null;
}

export interface ExtractedTaskCreatePlan extends ExtractedTaskParams {
  mode: "create" | "respond";
  response: string | null;
}

const VALID_CADENCE_KINDS = new Set([
  "once",
  "daily",
  "weekly",
  "times_per_day",
  "interval",
]);
const VALID_REQUEST_KINDS = new Set(["alarm", "reminder"]);
const VALID_CREATE_PLAN_MODES = new Set(["create", "respond"]);
const ALARM_CONTEXT_RE = /\b(alarm|wake(?:-|\s)?up|wake me up)\b/i;
const REMINDER_CONTEXT_RE =
  /\b(remind(?: me)?|reminder|set (?:a )?reminder|create (?:a )?reminder|nudge me|ping me)\b/i;
const REQUEST_KIND_VALIDATION_WINDOW = 6;
const DEFAULT_CREATE_PLAN_RESPONSE =
  "Restate the reminder in one sentence with the task and timing.";

const EMPTY_TASK_CREATE_PLAN: ExtractedTaskCreatePlan = {
  mode: "respond",
  response: DEFAULT_CREATE_PLAN_RESPONSE,
  requestKind: null,
  title: null,
  description: null,
  cadenceKind: null,
  windows: null,
  weekdays: null,
  timeOfDay: null,
  timeZone: null,
  everyMinutes: null,
  timesPerDay: null,
  priority: null,
  durationMinutes: null,
};

function promptText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "(empty)";
}

function parseStructuredRecord(raw: string): Record<string, unknown> | null {
  return parseToonKeyValue<Record<string, unknown>>(raw);
}

// ── Prompt ────────────────────────────────────────────

function buildExtractionPrompt(
  intent: string,
  recentConversation: string,
): string {
  return [
    "Plan the next step for a LifeOps create_definition request.",
    "Use the full current user request plus recent conversation.",
    "The user may speak informally, formally, code-switched, or in another language.",
    "Do not strip acknowledgements, fillers, or language-footer text. Interpret the whole request in context.",
    "Infer practical reminder windows from natural phrases when needed: wake up or before work -> morning, lunch or after lunch -> afternoon, after work or dinner -> evening, before bed or before sleep -> night.",
    "Return ONLY a TOON record with these fields (use null for unknown):",
    "",
    '- mode: "create" when the request is specific enough to create or preview a LifeOps item now, "respond" when you should reply without creating anything yet',
    '  Choose mode="create" whenever the user gives a title and cadence, even if they say "preview the plan", "don\'t save yet", "just show it first", or similar — the handler (not you) controls whether it is saved or previewed. Only use mode="respond" when the user hasn\'t specified what to track or when.',
    "- response: short natural-language reply when mode is respond, otherwise null",
    '- requestKind: "alarm" when this is explicitly an alarm/wake-up request, "reminder" when it is explicitly a reminder request, otherwise null',
    "- title: short name for the task (2-5 words)",
    "- description: brief description if the user provided context",
    '- cadenceKind: one of "once", "daily", "weekly", "times_per_day", "interval"',
    '  - "once" — a specific dated and/or timed event that happens a single time (e.g. "april 17 at 8pm", "tomorrow at 9", "set an alarm for 7am")',
    '  - "daily" — happens every day, typically with one time or window (e.g. "every morning", "every night")',
    '  - "weekly" — happens on specific weekdays (e.g. "every Sunday", "Mon/Wed/Fri")',
    '  - "times_per_day" — happens multiple times on the SAME recurring day, with multiple times or windows (e.g. "morning and night", "three times a day")',
    '  - "interval" — happens every N minutes/hours (e.g. "every 2 hours")',
    '  If the request names a specific calendar date OR a specific wall-clock time without a recurrence word, pick "once".',
    "- windows: list of time windows like [morning, night, afternoon, evening]",
    "- weekdays: list of weekday numbers (0=Sun, 1=Mon, ..., 6=Sat) for weekly tasks",
    '- timeOfDay: specific time in HH:MM 24h format like "15:00" or "08:30" if mentioned',
    '- timeZone: IANA timezone like "America/Denver" when the user explicitly gives one',
    '- everyMinutes: interval in minutes for recurring tasks (e.g., 120 for "every 2 hours")',
    '- timesPerDay: number of times per day if mentioned (e.g., 4 for "four times a day")',
    "- priority: 1-5 (1=low, 5=critical) based on urgency/importance language",
    "- durationMinutes: how long the activity takes if mentioned",
    "",
    "Examples:",
    'Input: "remind me to brush teeth morning and night"',
    "mode: create",
    "response: null",
    "requestKind: reminder",
    "title: Brush teeth",
    "cadenceKind: daily",
    "windows: [morning, night]",
    "weekdays: null",
    "timeOfDay: null",
    "everyMinutes: null",
    "timesPerDay: null",
    "",
    'Input: "call mom every Sunday at 3pm"',
    "mode: create",
    "response: null",
    "requestKind: null",
    "title: Call mom",
    "cadenceKind: weekly",
    "weekdays: [0]",
    "timeOfDay: 15:00",
    "",
    'Input: "lol yeah. can you help me add a todo for my life?"',
    "mode: respond",
    "response: What do you want the todo to be, and when should it happen?",
    "requestKind: null",
    "title: null",
    "cadenceKind: null",
    "",
    "Use recent conversation only to resolve short follow-ups. Do not emit requestKind='alarm' or requestKind='reminder' unless the current request or recent conversation explicitly supports it.",
    "If the user has not actually specified the todo/habit yet, choose mode='respond' and ask a concise clarifying question instead of inventing a task.",
    "",
    "Return ONLY valid TOON. No prose, markdown, code fences, or any other format.",
    "",
    `User request: ${promptText(intent)}`,
    "Recent conversation:",
    promptText(recentConversation),
  ].join("\n");
}

// ── Validators ────────────────────────────────────────

function validateTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateRequestKind(
  value: unknown,
): ExtractedTaskParams["requestKind"] {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return VALID_REQUEST_KINDS.has(normalized)
    ? (normalized as ExtractedTaskParams["requestKind"])
    : null;
}

function validateCreatePlanMode(
  value: unknown,
): ExtractedTaskCreatePlan["mode"] | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return VALID_CREATE_PLAN_MODES.has(normalized)
    ? (normalized as ExtractedTaskCreatePlan["mode"])
    : null;
}

function validateResponse(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateCadenceKind(
  value: unknown,
): ExtractedTaskParams["cadenceKind"] {
  if (typeof value !== "string") return null;
  return VALID_CADENCE_KINDS.has(value)
    ? (value as ExtractedTaskParams["cadenceKind"])
    : null;
}

function validateWindows(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const filtered = value.filter(
    (w: unknown) => typeof w === "string" && w.trim().length > 0,
  );
  return filtered.length > 0 ? filtered : null;
}

function validateWeekdays(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const filtered = value.filter(
    (d: unknown) =>
      typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6,
  );
  return filtered.length > 0 ? filtered : null;
}

function validateTimeOfDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Accept HH:MM format
  if (/^\d{1,2}:\d{2}$/.test(trimmed)) return trimmed;
  return null;
}

function validateTimeZone(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return normalizeExplicitTimeZoneToken(value);
}

function validatePositiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function validatePriority(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(1, Math.min(5, Math.round(value)));
}

function validateRequestKindAgainstContext(
  value: ExtractedTaskParams["requestKind"],
  currentText: string,
  recentWindow: string[],
): ExtractedTaskParams["requestKind"] {
  if (!value) {
    return null;
  }
  const texts = [currentText, ...recentWindow];
  const pattern = value === "alarm" ? ALARM_CONTEXT_RE : REMINDER_CONTEXT_RE;
  return texts.some((text) => pattern.test(text)) ? value : null;
}

function buildTaskCreatePlan(args: {
  parsed: Record<string, unknown>;
  intent: string;
  recentWindow: string[];
}): ExtractedTaskCreatePlan | null {
  const { parsed, intent, recentWindow } = args;
  const mode = validateCreatePlanMode(parsed.mode);
  if (!mode) {
    return null;
  }
  return {
    mode,
    response:
      mode === "respond"
        ? (validateResponse(parsed.response) ?? DEFAULT_CREATE_PLAN_RESPONSE)
        : null,
    requestKind: validateRequestKindAgainstContext(
      validateRequestKind(parsed.requestKind),
      intent,
      recentWindow.slice(-REQUEST_KIND_VALIDATION_WINDOW),
    ),
    title: validateTitle(parsed.title),
    description: validateTitle(parsed.description),
    cadenceKind: validateCadenceKind(parsed.cadenceKind),
    windows: validateWindows(parsed.windows),
    weekdays: validateWeekdays(parsed.weekdays),
    timeOfDay: validateTimeOfDay(parsed.timeOfDay),
    timeZone: validateTimeZone(parsed.timeZone),
    everyMinutes: validatePositiveNumber(parsed.everyMinutes),
    timesPerDay: validatePositiveNumber(parsed.timesPerDay),
    priority: validatePriority(parsed.priority),
    durationMinutes: validatePositiveNumber(parsed.durationMinutes),
  };
}

function buildRepairPrompt(args: {
  intent: string;
  recentConversation: string;
  rawResponse: string;
}): string {
  return [
    "Your last reply for the LifeOps create-definition planner was invalid.",
    "Return ONLY valid TOON with these exact fields:",
    "mode, response, requestKind, title, description, cadenceKind, windows, weekdays, timeOfDay, timeZone, everyMinutes, timesPerDay, priority, durationMinutes",
    "",
    'mode must be "create" or "respond".',
    "If mode is respond, include a short clarifying response.",
    "If mode is create, response must be null.",
    "",
    `User request: ${promptText(args.intent)}`,
    "Recent conversation:",
    promptText(args.recentConversation),
    "Previous invalid output:",
    promptText(args.rawResponse),
  ].join("\n");
}

function buildExtractionFailurePlan(): ExtractedTaskCreatePlan {
  return {
    ...EMPTY_TASK_CREATE_PLAN,
  };
}

// ── Extractor ─────────────────────────────────────────

/**
 * Call the LLM to plan whether a create_definition request should create
 * a task draft now or reply first, while also extracting structured
 * task parameters for the create path.
 */
export async function extractTaskCreatePlanWithLlm(args: {
  runtime: IAgentRuntime;
  intent: string;
  state: State | undefined;
  message?: Memory;
}): Promise<ExtractedTaskCreatePlan> {
  const { runtime, intent } = args;

  if (!intent || intent.trim().length === 0) {
    return buildExtractionFailurePlan();
  }

  const recentWindow = await recentConversationTexts({
    runtime,
    message: args.message,
    state: args.state,
    limit: Math.max(resolveContextWindow(), REQUEST_KIND_VALIDATION_WINDOW),
  });
  const recentConversation = recentWindow
    .slice(-resolveContextWindow())
    .join("\n");
  const prompt = buildExtractionPrompt(intent, recentConversation);

  const { parsed } = await runExtractorPipeline({
    runtime,
    prompt,
    parser: (raw) => {
      const parsedObject = parseStructuredRecord(raw);
      return parsedObject
        ? buildTaskCreatePlan({
            parsed: parsedObject,
            intent,
            recentWindow,
          })
        : null;
    },
    buildRepairPrompt: (rawFirstPass) =>
      buildRepairPrompt({
        intent,
        recentConversation,
        rawResponse: rawFirstPass,
      }),
  });

  return parsed ?? buildExtractionFailurePlan();
}

export async function extractTaskParamsWithLlm(args: {
  runtime: IAgentRuntime;
  intent: string;
  state: State | undefined;
  message?: Memory;
}): Promise<ExtractedTaskParams> {
  const plan = await extractTaskCreatePlanWithLlm(args);
  const { mode: _mode, response: _response, ...params } = plan;
  return params;
}

// ── Reminder intensity extractor ─────────────────────

const VALID_REMINDER_INTENSITIES: ReadonlySet<LifeOpsReminderIntensity> =
  new Set(LIFEOPS_REMINDER_INTENSITIES);

function isLifeOpsReminderIntensity(
  value: string,
): value is LifeOpsReminderIntensity {
  return VALID_REMINDER_INTENSITIES.has(value as LifeOpsReminderIntensity);
}

export interface ExtractedReminderIntensityPlan {
  intensity:
    | "minimal"
    | "normal"
    | "persistent"
    | "high_priority_only"
    | "unknown";
}

const EMPTY_REMINDER_INTENSITY_PLAN: ExtractedReminderIntensityPlan = {
  intensity: "unknown",
};

function parseReminderIntensityPlan(
  raw: string,
): ExtractedReminderIntensityPlan | null {
  const normalized = raw.trim().toLowerCase();
  if (isLifeOpsReminderIntensity(normalized)) {
    return {
      intensity: normalized,
    };
  }

  const parsed = parseStructuredRecord(raw);
  if (!parsed || typeof parsed.intensity !== "string") {
    return null;
  }
  const parsedIntensity = parsed.intensity.trim().toLowerCase();
  if (!isLifeOpsReminderIntensity(parsedIntensity)) {
    return null;
  }
  return {
    intensity: parsedIntensity,
  };
}

function buildReminderIntensityRepairPrompt(args: {
  intent: string;
  rawResponse: string;
}): string {
  return [
    "Your last reply for the LifeOps reminder-intensity extractor was invalid.",
    "Return ONLY valid TOON like:",
    "intensity: minimal",
    'Allowed intensity values: "minimal", "normal", "persistent", "high_priority_only".',
    "",
    `User said: ${promptText(args.intent)}`,
    "Previous invalid output:",
    promptText(args.rawResponse),
  ].join("\n");
}

/**
 * Ask a small text model to classify the user's intent into a reminder
 * intensity value. Returns an explicit "unknown" result when the model is
 * unavailable or the response is invalid so callers do not need regex
 * fallbacks.
 */
export async function extractReminderIntensityWithLlm(args: {
  runtime: IAgentRuntime;
  intent: string;
}): Promise<ExtractedReminderIntensityPlan> {
  const prompt = [
    "The user is requesting a change to their reminder frequency.",
    "Classify into exactly one of these values:",
    "- minimal: user wants fewer/less reminders",
    "- normal: user wants default/standard reminders",
    "- persistent: user wants more/frequent reminders",
    "- high_priority_only: user wants to pause or mute most reminders",
    "",
    "Return ONLY valid TOON like:",
    "intensity: minimal",
    "No prose, markdown, code fences, or any other format.",
    "",
    `User said: ${promptText(args.intent)}`,
  ].join("\n");

  const { parsed } = await runExtractorPipeline({
    runtime: args.runtime,
    prompt,
    modelType: ModelType.TEXT_SMALL,
    parser: parseReminderIntensityPlan,
    buildRepairPrompt: (rawFirstPass) =>
      buildReminderIntensityRepairPrompt({
        intent: args.intent,
        rawResponse: rawFirstPass,
      }),
  });

  return parsed ?? { ...EMPTY_REMINDER_INTENSITY_PLAN };
}

// ── Website unlock mode extractor ────────────────────

/** Valid unlock modes (mirrors shared/contracts/lifeops). */
const VALID_UNLOCK_MODES = new Set([
  "fixed_duration",
  "until_manual_lock",
  "until_callback",
]);

export interface ExtractedUnlockMode {
  mode: "fixed_duration" | "until_manual_lock" | "until_callback";
  callbackKey?: string;
  durationMinutes?: number;
}

/**
 * Ask a small text model to determine the website unlock mode from the
 * user's intent.  Returns null when the model is unavailable, throws, or
 * returns an invalid value — callers should fall back to regex.
 */
export async function extractUnlockModeWithLlm(args: {
  runtime: IAgentRuntime;
  intent: string;
}): Promise<ExtractedUnlockMode | null> {
  if (typeof args.runtime.useModel !== "function") return null;

  const prompt = [
    "The user is configuring website blocking. Determine the unlock mode:",
    "- fixed_duration: unlock for a specific time period (extract durationMinutes)",
    "- until_manual_lock: unlock until user manually re-locks",
    "- until_callback: unlock until a specific event/task completes (extract callbackKey as a slug)",
    "",
    "Return a TOON record with fields: mode, durationMinutes, callbackKey.",
    "Use mode: null if no unlock mode is detectable.",
    "",
    `User said: ${promptText(args.intent)}`,
  ].join("\n");

  try {
    const result = await runWithTrajectoryContext(
      { purpose: "lifeops-extract-task-plan-unlock" },
      () =>
        args.runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        }),
    );
    const raw = typeof result === "string" ? result : "";
    const parsed = parseStructuredRecord(raw);
    if (!parsed?.mode) return null;
    if (!VALID_UNLOCK_MODES.has(parsed.mode as string)) return null;
    return {
      mode: parsed.mode as ExtractedUnlockMode["mode"],
      callbackKey:
        typeof parsed.callbackKey === "string"
          ? parsed.callbackKey.trim() || undefined
          : undefined,
      durationMinutes:
        typeof parsed.durationMinutes === "number" &&
        Number.isFinite(parsed.durationMinutes) &&
        parsed.durationMinutes > 0
          ? parsed.durationMinutes
          : undefined,
    };
  } catch {
    return null;
  }
}

// Re-export for tests
export { buildExtractionPrompt };
