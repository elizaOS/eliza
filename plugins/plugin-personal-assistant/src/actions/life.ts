/**
 * Shared create/update/query engine for owner "life" items — reminder/todo/
 * routine definitions and goals — that backs the OWNER_* surfaces built in
 * `owner-surfaces.ts`.
 *
 * Classifies a natural-language request into a life operation, extracts the
 * structured definition and cadence via the LLM extractors in `lib/`, and
 * resolves one-off due dates against the owner timezone. Multi-turn create
 * flows preview a draft and save on a follow-up confirmation turn.
 */
import {
  extractConversationMetadataFromRoom,
  isPageScopedConversationMetadata,
  renderGroundedActionReply,
} from "@elizaos/agent";
import type {
  ActionResult,
  AgentContext,
  EffectReceipt,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  ElizaError,
  logger,
  normalizeEffectReceipt,
  resolveActionArgs,
  type SubactionsMap,
} from "@elizaos/core";
import type {
  CreateLifeOpsDefinitionRequest,
  CreateLifeOpsGoalRequest,
  LifeOpsCadence,
  LifeOpsDailySlot,
  LifeOpsDefinitionRecord,
  LifeOpsDomain,
  LifeOpsGoalRecord,
  LifeOpsWindowPolicy,
  UpdateLifeOpsDefinitionRequest,
  UpdateLifeOpsGoalRequest,
} from "../contracts/index.js";
import {
  calendarReadUnavailableMessage,
  getGoogleCapabilityStatus,
  gmailReadUnavailableMessage,
  INTERNAL_URL,
} from "../lifeops/access.js";
import {
  completeLifeOpsEffect,
  lifeOpsAppliedEffect,
  lifeOpsFailedEffect,
  lifeOpsNoopEffect,
} from "../lifeops/action-effect-result.js";
import {
  buildNativeAppleReminderMetadata,
  type NativeAppleReminderLikeKind,
} from "../lifeops/apple-reminders.js";
import {
  resolveDefaultTimeZone,
  resolveDefaultWindowPolicy,
} from "../lifeops/defaults.js";
import {
  dayRange,
  detailArray,
  detailBoolean,
  detailNumber,
  detailObject,
  detailString,
  formatCalendarEventDateTime,
  formatEmailTriage,
  formatOverviewForQuery,
  messageText,
  toActionData,
} from "../lifeops/google/format-helpers.js";
import { resolveOwnerTimeZone } from "../lifeops/owner/fact-store.js";
import type { LifeOpsDefinitionScope } from "../lifeops/repository.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { normalizeExplicitTimeZoneToken } from "../lifeops/time/timezone.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "../lifeops/time.js";
import {
  extractGoalCreatePlanWithLlm,
  extractGoalUpdatePlanWithLlm,
  mergeGoalMetadataWithGrounding,
} from "./lib/extract-goal-plan.js";
import {
  type ExtractedLifeMissingField,
  type ExtractedLifeOperation,
  extractLifeOperationWithLlm,
} from "./lib/extract-life-operation.js";
import {
  type ExtractedTaskParams,
  extractTaskCreatePlanWithLlm,
} from "./lib/extract-task-plan.js";
import {
  type ExtractedUpdateFields,
  extractUpdateFieldsWithLlm,
} from "./lib/extract-update-fields.js";
import {
  clearDeferredLifeDraftCache,
  clearRecentLifeSaveCache,
  countTurnsSinceLatestDeferredLifeDraft,
  type DeferredLifeDefinitionDraft,
  type DeferredLifeDraft,
  type DeferredLifeDraftFollowupMode,
  type DeferredLifeDraftReuseMode,
  type DeferredLifeGoalDraft,
  deferredLifeDraftExpiryReason,
  extractDeferredLifeDraftFollowupWithLlm,
  isLifeSaveRetraction,
  latestDeferredLifeDraft,
  readDeferredLifeDraftCache,
  readRecentLifeSaveCache,
  writeDeferredLifeDraftCache,
  writeRecentLifeSaveCache,
} from "./lib/lifeops-deferred-draft.js";
import {
  applyOwnerPolicyConfigureEscalation,
  applyOwnerPolicySetReminder,
} from "./lib/owner-policy-writes.js";

// ── Types ─────────────────────────────────────────────

type LifeOperation = ExtractedLifeOperation;
type LifeOwnedOperation = Exclude<
  LifeOperation,
  | "query_calendar_today"
  | "query_calendar_next"
  | "query_email"
  | "query_overview"
>;
/** Internal handler discriminator: definition vs goal flow. */
type LifeKind = "definition" | "goal";
type ResolvedLifeOperationPlan = {
  confidence: number | null;
  missing: ExtractedLifeMissingField[];
  operation: LifeOperation | null;
  kind?: LifeKind;
  shouldAct: boolean;
  /**
   * Params extracted by the shared `resolveActionArgs` pass (target, minutes,
   * preset, …). Gap-fillers only — explicit planner-supplied params win.
   */
  params?: LifeParams;
};

type LifeParams = {
  action?: string;
  subaction?: LifeOperation;
  kind?: LifeKind;
  intent?: string;
  title?: string;
  target?: string;
  minutes?: number;
  preset?: string;
  /**
   * Planner-signalled owner confirmation of a previously previewed save.
   * The preview -> confirm handshake has no structured cross-turn draft
   * transport on the planner path, so the confirm turn ("yes, save that")
   * must re-call create with `confirmed: true`; the handler then saves the
   * re-extracted plan instead of previewing again.
   */
  confirmed?: boolean;
  details?: Record<string, unknown>;
  ownerSurface?: string;
};

const SUBACTIONS = {
  create: {
    description:
      "Create a life-item: kind=definition (habit/routine/reminder/alarm/todo) or kind=goal (long-term aspiration).",
    descriptionCompressed:
      "create life-item definition(habit|routine|reminder|alarm|todo)|goal; infer cadence/title",
    required: ["kind", "title"],
    optional: ["intent", "details"],
  },
  update: {
    description:
      "Update an existing life-item by id or title (kind: definition or goal).",
    descriptionCompressed: "update life-item by id/title: kind, target, fields",
    required: ["kind", "target"],
    optional: ["title", "details"],
  },
  delete: {
    description:
      "Delete a life-item by id or title (kind: definition or goal).",
    descriptionCompressed: "delete life-item by id/title",
    required: ["kind", "target"],
  },
  complete: {
    description: "Mark an occurrence as done.",
    descriptionCompressed: "mark occurrence done",
    required: ["target"],
  },
  skip: {
    description: "Skip an occurrence.",
    descriptionCompressed: "skip occurrence",
    required: ["target"],
  },
  snooze: {
    description:
      "Snooze an occurrence by minutes or preset duration. minutes: numeric duration ('snooze 45 minutes' -> 45). preset: one of 15m | 30m | 1h | tonight | tomorrow_morning ('snooze until tomorrow morning' -> tomorrow_morning).",
    descriptionCompressed:
      "snooze occurrence; minutes=numeric duration; preset=15m|30m|1h|tonight|tomorrow_morning",
    required: ["target"],
    optional: ["minutes", "preset"],
  },
  review: {
    description: "Review progress on a goal.",
    descriptionCompressed: "review goal progress",
    required: ["target"],
  },
  policy_set_reminder: {
    description:
      "Set reminder intensity policy on the OwnerFactStore: minimal | normal | persistent | high_priority_only. Optional per-definition target.",
    descriptionCompressed:
      "policy.set_reminder: intensity=minimal|normal|persistent|high_priority_only",
    required: [],
    optional: ["intent", "details"],
  },
  policy_configure_escalation: {
    description:
      "Configure escalation policy on the OwnerFactStore (timeoutMinutes, callAfterMinutes). Optional per-definition target.",
    descriptionCompressed:
      "policy.configure_escalation: timeout-minutes call-after-no-response",
    required: [],
    optional: ["intent", "details"],
  },
} as const satisfies SubactionsMap<LifeOwnedOperation>;

/**
 * Internal handler key — the dispatch table inside the action handler still
 * branches on definition-vs-goal for create/update/delete because the
 * underlying LifeOpsService methods are split. The umbrella surface (the
 * SUBACTIONS map above) uses the 7 plain verbs and resolves the kind
 * separately via params.kind.
 */
type InternalLifeOp =
  | "create_definition"
  | "create_goal"
  | "update_definition"
  | "update_goal"
  | "delete_definition"
  | "delete_goal"
  | "complete_occurrence"
  | "skip_occurrence"
  | "snooze_occurrence"
  | "review_goal"
  | "policy_set_reminder"
  | "policy_configure_escalation";

function toInternalLifeOp(
  operation: LifeOwnedOperation,
  kind: LifeKind | undefined,
): InternalLifeOp {
  switch (operation) {
    case "create":
      return kind === "goal" ? "create_goal" : "create_definition";
    case "update":
      return kind === "goal" ? "update_goal" : "update_definition";
    case "delete":
      return kind === "goal" ? "delete_goal" : "delete_definition";
    case "complete":
      return "complete_occurrence";
    case "skip":
      return "skip_occurrence";
    case "snooze":
      return "snooze_occurrence";
    case "review":
      return "review_goal";
    case "policy_set_reminder":
      return "policy_set_reminder";
    case "policy_configure_escalation":
      return "policy_configure_escalation";
  }
}

function inferLifeKindFromIntent(intent: string): LifeKind {
  const normalized = intent.toLowerCase();
  if (
    /\bgoal\b|\baspirat|achiev|long[\s-]?term/.test(normalized) ||
    /\bi (?:want|hope|wish|aspire) to\b/.test(normalized)
  ) {
    return "goal";
  }
  return "definition";
}

function looksLikeGoalTrackingFollowup(intent: string): boolean {
  const normalized = intent.toLowerCase();
  const mentionsFrequency =
    /\b(?:\d+|one|two|three|four|five|six|seven)\s+times?\s+(?:a|per)\s+week\b/i.test(
      normalized,
    ) || /\b\d+\s*\/\s*week\b/i.test(normalized);
  return (
    /\bcount\s+it\s+if\b/i.test(normalized) &&
    (mentionsFrequency ||
      /\bnext\s+\d+\s+weeks?\b/i.test(normalized) ||
      /\bwalk\s+around\s+the\s+block\b/i.test(normalized))
  );
}

const GENERIC_DERIVED_TITLE_RE =
  /^(?:new\s+)?(?:habit|routine|task|goal|life goal|thing|item|something|anything|stuff|plan|reminder|todo|to do|achieve|achieve a|achieve an)$/i;
const BROAD_LIFE_DELETE_TARGET_RE =
  /^(?:all|everything|every\s+thing|all\s+(?:of\s+)?(?:it|them|this|that)|all\s+my\s+(?:reminders?|tasks?|todos?|to[- ]?dos?|goals?|habits?|routines?)|my\s+(?:whole|entire)\s+(?:list|schedule|routine|todo\s+list|to[- ]?do\s+list))$/i;
const BROAD_LIFE_DELETE_INTENT_RE =
  /\b(?:delete|remove|cancel|wipe|clear|get rid of|stop tracking)\b[\s\S]{0,80}\b(?:everything|all\s+(?:of\s+)?(?:it|them|this|that)|all\s+my\s+(?:reminders?|tasks?|todos?|to[- ]?dos?|goals?|habits?|routines?))\b/i;
const EMOTIONAL_DESTRUCTIVE_DELETE_RE =
  /\b(?:i\s+give\s+up|can't\s+do\s+(?:this|any\s+of\s+this)|clearly\s+can't|forget\s+it|i'?m\s+done|rage\s*quit|spiral(?:ing)?)\b/i;

function normalizeLifeTimeZoneToken(
  value: string | null | undefined,
): string | null {
  return normalizeExplicitTimeZoneToken(value);
}

function isBroadLifeDeleteRequest(args: {
  intent: string;
  targetName: string | undefined;
}): boolean {
  const normalizedTarget = normalizeTitle(args.targetName ?? "");
  if (normalizedTarget && BROAD_LIFE_DELETE_TARGET_RE.test(normalizedTarget)) {
    return true;
  }
  return (
    BROAD_LIFE_DELETE_INTENT_RE.test(args.intent) ||
    (/\bdelete\b|\bremove\b|\bwipe\b|\bclear\b/i.test(args.intent) &&
      EMOTIONAL_DESTRUCTIVE_DELETE_RE.test(args.intent))
  );
}

function isLifeOwnedOperation(
  value: LifeOperation | null | undefined,
): value is LifeOwnedOperation {
  return (
    value != null &&
    value !== "query_calendar_today" &&
    value !== "query_calendar_next" &&
    value !== "query_email" &&
    value !== "query_overview"
  );
}

function normalizeExplicitLifeAction(value: unknown):
  | {
      operation: LifeOperation;
      kind?: LifeKind;
    }
  | "phone"
  | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  switch (normalized) {
    case "create_goal":
    case "goal_create":
      return { operation: "create", kind: "goal" };
    case "create_definition":
    case "create_habit":
    case "create_routine":
    case "create_reminder":
    case "create_todo":
      return { operation: "create", kind: "definition" };
    case "calendar":
    case "query_calendar":
    case "query_calendar_today":
      return { operation: "query_calendar_today" };
    case "query_calendar_next":
    case "next_calendar":
      return { operation: "query_calendar_next" };
    case "email":
    case "gmail":
    case "query_email":
      return { operation: "query_email" };
    case "overview":
    case "query_overview":
      return { operation: "query_overview" };
    case "phone":
    case "capture_phone":
      return "phone";
    default:
      return isLifeOwnedOperation(normalized as LifeOperation)
        ? { operation: normalized as LifeOwnedOperation }
        : null;
  }
}

async function resolveLifeOperationPlan(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  explicitOperation: LifeOperation | undefined;
}): Promise<ResolvedLifeOperationPlan> {
  const { runtime, message, state, intent, explicitOperation } = args;
  if (explicitOperation) {
    return {
      operation: explicitOperation,
      confidence: 1,
      missing: [],
      shouldAct: true,
    };
  }

  const extracted = await extractLifeOperationWithLlm({
    runtime,
    message,
    state,
    intent,
  });
  if (
    !extracted.shouldAct ||
    !extracted.operation ||
    !isLifeOwnedOperation(extracted.operation)
  ) {
    return {
      operation: isLifeOwnedOperation(extracted.operation)
        ? extracted.operation
        : null,
      confidence: extracted.confidence,
      missing: extracted.missing,
      shouldAct: false,
    };
  }
  return {
    operation: extracted.operation,
    confidence: extracted.confidence,
    missing: extracted.missing,
    shouldAct: true,
  };
}

/**
 * Pre-routing pick of the owner operation action.
 *
 * Tries the shared `resolveActionArgs` substrate first (planner-trust path
 * + single LLM pass). Falls back to the LifeOps-specific extractor when
 * `resolveActionArgs` cannot pick a subaction confidently — that extractor
 * carries richer "missing field" diagnostics (`title`, `schedule`, etc.)
 * that downstream clarification messaging depends on.
 */
async function routeLifeSubaction(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  options: HandlerOptions | undefined;
  intent: string;
  explicitSubaction: LifeOperation | undefined;
}): Promise<ResolvedLifeOperationPlan> {
  const { runtime, message, state, options, intent, explicitSubaction } = args;
  if (explicitSubaction && !isLifeOwnedOperation(explicitSubaction)) {
    return {
      operation: explicitSubaction,
      confidence: 1,
      missing: [],
      shouldAct: true,
    };
  }
  const resolved = await resolveActionArgs<LifeOwnedOperation, LifeParams>({
    runtime,
    message,
    state,
    options,
    actionName: ownerSurfaceActionNameFromOptions(options),
    subactions: SUBACTIONS,
    intentHint: intent,
  });

  if (resolved.ok) {
    return {
      operation: resolved.subaction,
      confidence: 1,
      missing: [],
      shouldAct: true,
      params: resolved.params,
    };
  }

  return resolveLifeOperationPlan({
    runtime,
    message,
    state,
    intent,
    explicitOperation: explicitSubaction,
  });
}

function resolveDeferredLifeDraftReuseMode(args: {
  details: Record<string, unknown> | undefined;
  draft: DeferredLifeDraft | null;
  explicitConfirmation?: boolean;
  explicitOperation: LifeOperation | undefined;
  llmMode?: DeferredLifeDraftFollowupMode;
  /** Number of messages since the draft was stored. */
  turnsSinceDraft?: number;
}): DeferredLifeDraftReuseMode | null {
  if (!args.draft) {
    return null;
  }

  if (deferredLifeDraftExpiryReason(args)) {
    return null;
  }

  if (detailBoolean(args.details, "confirmed") === true) {
    return "confirm";
  }

  const explicitOperation = args.explicitOperation
    ? String(args.explicitOperation)
    : undefined;
  const draftOperation = String(args.draft.operation);
  const explicitOperationMatchesDraft =
    explicitOperation === draftOperation ||
    (explicitOperation === "create" && draftOperation.startsWith("create_"));
  if (explicitOperation && !explicitOperationMatchesDraft) {
    return null;
  }

  if (args.explicitConfirmation === true) {
    return "confirm";
  }

  if (args.llmMode === "confirm" || args.llmMode === "edit") {
    return args.llmMode;
  }
  return null;
}

const LIFE_CONFIRMATION_VETO_RE =
  /\b(?:no|not|don t|do not|cancel|hold off|wait|later|change)\b/u;
const LIFE_CONFIRMATION_CUE_RE =
  /\b(?:ok|okay|yes|yep|yeah|sure|confirm|confirmed|approve|approved|save it|save that|save this|save the goal|set it|lock it in|do it|looks good|that works|go ahead)\b/u;

// Sentence-scoped on purpose: a message-wide negation veto turned "yes lock
// it in! and can it bug me before friday too, not just friday morning" into
// a non-confirmation, so three consecutive confirmed creates previewed and
// nothing persisted (#16941 live). A sentence that carries its own negation
// ("don't save that one") still never counts as consent.
function isExplicitLifeCreateConfirmation(text: string): boolean {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/u);
  for (const sentence of sentences) {
    const normalized = sentence
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    if (!normalized) {
      continue;
    }
    if (LIFE_CONFIRMATION_VETO_RE.test(normalized)) {
      continue;
    }
    if (LIFE_CONFIRMATION_CUE_RE.test(normalized)) {
      return true;
    }
  }
  return false;
}

// A confirmation is "bare" when stripping the yes-cues and politeness filler
// leaves essentially nothing — "yes save it exactly like that." is bare,
// "yes, save that plan. draft first, citations after dinner…" is not.
const LIFE_CONFIRMATION_CUE_STRIP_RE =
  /\b(?:ok|okay|yes|yep|yeah|sure|confirm|confirmed|approve|approved|save it|save that|save this|save the goal|set it|lock it in|do it|looks good|that works|go ahead)\b/gu;
const LIFE_CONFIRMATION_FILLER_STRIP_RE =
  /\b(?:please|pls|thanks|thank you|now|just|exactly|like|that|this|it|the|one|plan|sounds|good|great|perfect|awesome)\b/gu;

function isBareLifeCreateConfirmationMessage(text: string): boolean {
  if (!isExplicitLifeCreateConfirmation(text)) {
    return false;
  }
  const residue = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(LIFE_CONFIRMATION_CUE_STRIP_RE, " ")
    .replace(LIFE_CONFIRMATION_FILLER_STRIP_RE, " ")
    .trim();
  return residue.length <= 3;
}

function stringifyLifeDetailForPrompt(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => stringifyLifeDetailForPrompt(entry))
      .filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries.join(", ") : null;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => {
        const rendered = stringifyLifeDetailForPrompt(entry);
        return rendered ? `${key}: ${rendered}` : null;
      })
      .filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries.join("; ") : null;
  }
  return null;
}

function summarizeGoalSupportStrategyForPreview(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["summary", "firstStep"] as const) {
    const rendered = stringifyLifeDetailForPrompt(record[key]);
    if (rendered) {
      parts.push(rendered);
    }
  }
  const suggestedSupport = record.suggestedSupport;
  if (Array.isArray(suggestedSupport)) {
    const supportItems = suggestedSupport
      .map((entry) => stringifyLifeDetailForPrompt(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (supportItems.length > 0) {
      parts.push(`Support includes ${supportItems.join(", ")}.`);
    }
  }
  return parts.length > 0 ? `Support plan: ${parts.join(" ")}` : null;
}

function textIncludesGoalDateDetail(text: string): boolean {
  return /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{4}-\d{2}-\d{2})\b/i.test(
    text,
  );
}

function textIncludesGoalCadenceDetail(text: string): boolean {
  return /\b(?:daily|weekly|monthly|weekday|weekends?|per\s+(?:day|week|month)|times?\s+(?:a|per)\s+(?:day|week|month)|blocks?|sessions?|practice)\b/i.test(
    text,
  );
}

function cleanGoalPreviewDetailText(text: string): string {
  return text
    .replace(
      /^(?:let'?s\s+define\s+success\s+as|define\s+success\s+as|make\s+it\s+mean|count\s+it\s+if)\s+/i,
      "",
    )
    .trim();
}

function summarizeGoalInputDetailsForPreview(
  inputText: string,
  previewText: string,
): string | null {
  const detailText = cleanGoalPreviewDetailText(inputText);
  if (!detailText) {
    return null;
  }
  const inputHasDate = textIncludesGoalDateDetail(detailText);
  const previewHasConcreteDate =
    textIncludesGoalDateDetail(previewText) &&
    !/\b(?:the\s+)?deadline\b/i.test(previewText);
  const inputHasCadence = textIncludesGoalCadenceDetail(detailText);
  const previewHasCadence = textIncludesGoalCadenceDetail(previewText);
  if (
    (inputHasDate && !previewHasConcreteDate) ||
    (inputHasCadence && !previewHasCadence)
  ) {
    return `Details: ${detailText}`;
  }
  return null;
}

function buildGoalGroundingIntent(
  intent: string,
  details: Record<string, unknown> | undefined,
): string {
  if (!details) {
    return intent;
  }
  const detailLines = Object.entries(details)
    .filter(([key]) => key !== "confirmed" && key !== "metadata")
    .map(([key, value]) => {
      const rendered = stringifyLifeDetailForPrompt(value);
      return rendered ? `${key}: ${rendered}` : null;
    })
    .filter((entry): entry is string => Boolean(entry));
  if (detailLines.length === 0) {
    return intent;
  }
  return `${intent}\nDetails:\n${detailLines.join("\n")}`;
}

function shouldForceLifeCreateExecution(args: {
  intent: string;
  missing: ExtractedLifeMissingField[];
  operation: LifeOperation | null;
  kind: LifeKind | undefined;
  details: Record<string, unknown> | undefined;
  title: string | undefined;
}): boolean {
  if (args.operation !== "create" || args.kind === "goal") {
    return false;
  }

  const blockingFields = args.missing.filter(
    (field) => field !== "title" && field !== "schedule",
  );
  if (blockingFields.length > 0) {
    return false;
  }

  if (typeof args.title === "string" && args.title.trim().length > 0) {
    return true;
  }

  if (normalizeCadenceDetail(detailObject(args.details, "cadence"))) {
    return true;
  }
  return false;
}

// ── Helpers ───────────────────────────────────────────

type LifeSnoozePreset = "15m" | "30m" | "1h" | "tonight" | "tomorrow_morning";

const LIFE_SNOOZE_PRESETS: ReadonlySet<string> = new Set([
  "15m",
  "30m",
  "1h",
  "tonight",
  "tomorrow_morning",
] satisfies LifeSnoozePreset[]);

function normalizeSnoozePreset(value: unknown): LifeSnoozePreset | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  return LIFE_SNOOZE_PRESETS.has(normalized)
    ? (normalized as LifeSnoozePreset)
    : undefined;
}

/** LLM-extracted params arrive as raw JSON — minutes may be a numeric string. */
function normalizeSnoozeMinutes(value: unknown): number | undefined {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function requestedOwnership(domain?: LifeOpsDomain) {
  if (domain === "agent_ops") {
    return { domain: "agent_ops" as const, subjectType: "agent" as const };
  }
  return { domain: "user_lifeops" as const, subjectType: "owner" as const };
}

function definitionMutationScope(args: {
  runtime: IAgentRuntime;
  message: Memory;
  domain?: LifeOpsDomain;
}): LifeOpsDefinitionScope {
  const ownership = requestedOwnership(args.domain);
  return {
    agentId: String(args.runtime.agentId),
    ...ownership,
    subjectId:
      ownership.subjectType === "agent"
        ? String(args.runtime.agentId)
        : String(args.message.entityId),
  };
}

function definitionRevision(record: LifeOpsDefinitionRecord): number | null {
  const revision = (record.definition as { revision?: unknown }).revision;
  return typeof revision === "number" &&
    Number.isInteger(revision) &&
    revision > 0
    ? revision
    : null;
}

function definitionMutationFailureCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return error instanceof Error && error.name
    ? error.name
    : "LIFEOPS_DEFINITION_MUTATION_FAILED";
}

function normalizeIntentText(value: string): string {
  return normalizeLifeInputText(value).toLowerCase();
}

function normalizeLifeInputText(value: string): string {
  return value
    .replace(/[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPrimaryLifeInputText(value: string): string {
  const startMarker = "<<<EXTERNAL_UNTRUSTED_CONTENT>>>";
  const endMarker = "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";
  const start = value.lastIndexOf(startMarker);
  if (start < 0) {
    return value;
  }

  const afterStart = value.slice(start + startMarker.length);
  const end = afterStart.indexOf(endMarker);
  const block = end >= 0 ? afterStart.slice(0, end) : afterStart;
  const delimiter = block.lastIndexOf("\n---");
  const payload = (delimiter >= 0 ? block.slice(delimiter + 4) : block).trim();
  return payload.length > 0 ? payload : value;
}

function normalizeTitle(value: string): string {
  return normalizeIntentText(value);
}

function goalSuccessCriteriaLooksConcrete(
  request: Pick<CreateLifeOpsGoalRequest, "successCriteria">,
): boolean {
  const criteriaText = JSON.stringify(request.successCriteria ?? "")
    .toLowerCase()
    .trim();
  if (!criteriaText) {
    return false;
  }
  return (
    /\d/.test(criteriaText) ||
    /\b(once|twice|daily|weekly|monthly)\b|(?:\bevery|\beach)\s+(?:day|week|month)\b|\bwithin\s+(?:a|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:day|week|month)s?\b/.test(
      criteriaText,
    )
  );
}

function ownerTextHasConcreteGoalCriteria(value: string): boolean {
  const text = normalizeIntentText(value);
  return (
    /(?:\$|€|£)\s*\d/.test(text) ||
    /\b\d+\s*(?:x|times?|sessions?|blocks?|minutes?|mins?|hours?|days?|weeks?|months?|years?|percent|%)\b/.test(
      text,
    ) ||
    /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:times?|sessions?|blocks?|minutes?|mins?|hours?|days?|weeks?|months?|years?)\b/.test(
      text,
    ) ||
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/.test(
      text,
    ) ||
    /\b(?:once|twice|daily|weekly|monthly|every day|each day|every week|each week|per week|per month)\b/.test(
      text,
    )
  );
}

function buildConcreteGoalSuccessQuestion(title: string): string {
  return `I can draft this as "${title}", and I will not save it yet. What would count as success: how often you want to do it, what kind of attempt counts, or what evidence I should track?`;
}

function summaryFromGoalSection(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const summary = (value as { summary?: unknown }).summary;
  return typeof summary === "string" && summary.trim().length > 0
    ? summary.trim()
    : null;
}

function buildSavedGoalReply(goal: {
  title: string;
  successCriteria?: unknown;
  supportStrategy?: unknown;
}): string {
  const parts = [`Saved — "${goal.title}".`];
  const successSummary = summaryFromGoalSection(goal.successCriteria);
  const supportSummary = summaryFromGoalSection(goal.supportStrategy);
  if (successSummary) {
    parts.push(`Success: ${successSummary}`);
  }
  if (supportSummary) {
    parts.push(`Plan: ${supportSummary}`);
  }
  return parts.join(" ");
}

function matchByTitle<
  T extends { definition?: { title: string }; goal?: { title: string } },
>(entries: T[], targetTitle: string): T | null {
  const normalized = normalizeTitle(targetTitle);
  return (
    entries.find(
      (e) =>
        normalizeTitle(e.definition?.title ?? e.goal?.title ?? "") ===
        normalized,
    ) ??
    entries.find((e) =>
      normalizeTitle(e.definition?.title ?? e.goal?.title ?? "").includes(
        normalized,
      ),
    ) ??
    null
  );
}

async function resolveGoal(
  service: LifeOpsService,
  target: string | undefined,
  domain?: LifeOpsDomain,
): Promise<LifeOpsGoalRecord | null> {
  if (!target) return null;
  const goals = (await service.listGoals()).filter((e) =>
    domain ? e.goal.domain === domain : true,
  );
  return goals.find((e) => e.goal.id === target) ?? matchByTitle(goals, target);
}

async function resolveDefinition(
  service: LifeOpsService,
  target: string | undefined,
  domain?: LifeOpsDomain,
): Promise<LifeOpsDefinitionRecord | null> {
  if (!target) return null;
  const defs = (await service.listDefinitions()).filter((e) =>
    domain ? e.definition.domain === domain : true,
  );
  return (
    defs.find((e) => e.definition.id === target) ?? matchByTitle(defs, target)
  );
}

type DefinitionMutationSelection = {
  match: LifeOpsDefinitionRecord | null;
  ambiguousCandidates: string[];
};

function includesNormalizedPhrase(text: string, phrase: string): boolean {
  return phrase.length > 0 && ` ${text} `.includes(` ${phrase} `);
}

async function resolveDefinitionForMutation(
  service: LifeOpsService,
  target: string | undefined,
  ownerText: string,
  domain?: LifeOpsDomain,
): Promise<DefinitionMutationSelection> {
  const definitions = (await service.listDefinitions()).filter((entry) =>
    domain ? entry.definition.domain === domain : true,
  );
  const normalizedOwnerText = normalizeTitle(ownerText);
  const grounded = definitions.filter((entry) => {
    const title = normalizeTitle(entry.definition.title);
    return includesNormalizedPhrase(normalizedOwnerText, title);
  });
  if (grounded.length === 1) {
    return { match: grounded[0] ?? null, ambiguousCandidates: [] };
  }
  if (grounded.length > 1) {
    return {
      match: null,
      ambiguousCandidates: grounded.map((entry) => entry.definition.title),
    };
  }

  const ownerSelectedId = definitions.find(
    (entry) =>
      entry.definition.id === target &&
      includesNormalizedPhrase(
        normalizedOwnerText,
        normalizeTitle(entry.definition.id),
      ),
  );
  if (ownerSelectedId) {
    return { match: ownerSelectedId, ambiguousCandidates: [] };
  }

  const normalizedTarget = normalizeTitle(target ?? "");
  const candidates =
    normalizedTarget.length === 0
      ? []
      : definitions.filter((entry) => {
          const title = normalizeTitle(entry.definition.title);
          return (
            title === normalizedTarget ||
            title.includes(normalizedTarget) ||
            normalizedTarget.includes(title)
          );
        });
  return {
    match: null,
    ambiguousCandidates: candidates.map((entry) => entry.definition.title),
  };
}

function tokenizeTitle(value: string): string[] {
  return normalizeTitle(value)
    .split(" ")
    .filter((token) => token.length >= 3);
}

export async function resolveDefinitionFromIntent(
  service: LifeOpsService,
  target: string | undefined,
  intent: string,
  domain?: LifeOpsDomain,
): Promise<LifeOpsDefinitionRecord | null> {
  const direct = await resolveDefinition(service, target, domain);
  if (direct) {
    return direct;
  }
  const defs = (await service.listDefinitions()).filter((entry) =>
    domain ? entry.definition.domain === domain : true,
  );
  const intentTokens = new Set(tokenizeTitle(intent));
  let best: LifeOpsDefinitionRecord | null = null;
  let bestScore = 0;
  let tied = false;
  for (const entry of defs) {
    const title = normalizeTitle(entry.definition.title);
    if (title.length > 0 && normalizeTitle(intent).includes(title)) {
      return entry;
    }
    const overlap = tokenizeTitle(entry.definition.title).filter((token) =>
      intentTokens.has(token),
    ).length;
    if (overlap === 0) {
      continue;
    }
    if (overlap > bestScore) {
      best = entry;
      bestScore = overlap;
      tied = false;
      continue;
    }
    if (overlap === bestScore) {
      tied = true;
    }
  }
  return bestScore > 0 && !tied ? best : null;
}

type OccurrenceResult = {
  match:
    | Awaited<
        ReturnType<LifeOpsService["getOverview"]>
      >["owner"]["occurrences"][number]
    | null;
  /** Non-empty only when resolution was ambiguous (2+ substring matches, no exact/prefix winner). */
  ambiguousCandidates: string[];
};

function formatOccurrenceDisambiguationLabel(
  occurrence: Awaited<
    ReturnType<LifeOpsService["getOverview"]>
  >["owner"]["occurrences"][number],
): string {
  const hints: string[] = [];
  if (
    typeof occurrence.windowName === "string" &&
    occurrence.windowName.trim()
  ) {
    hints.push(occurrence.windowName.trim());
  }
  if (occurrence.dueAt) {
    const dueAt = new Date(occurrence.dueAt);
    if (!Number.isNaN(dueAt.getTime())) {
      hints.push(
        dueAt.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
      );
    }
  }
  return hints.length > 0
    ? `${occurrence.title} (${hints.join(", ")})`
    : occurrence.title;
}

function narrowOccurrenceCandidates(
  matches: Awaited<
    ReturnType<LifeOpsService["getOverview"]>
  >["owner"]["occurrences"],
) {
  const actionableMatches = matches.filter(
    (occurrence) =>
      occurrence.state === "visible" || occurrence.state === "snoozed",
  );
  return actionableMatches.length > 0 ? actionableMatches : matches;
}

async function resolveOccurrence(
  service: LifeOpsService,
  target: string | undefined,
  domain?: LifeOpsDomain,
): Promise<OccurrenceResult> {
  if (!target) return { match: null, ambiguousCandidates: [] };
  const overview = await service.getOverview();
  const all = [
    ...overview.owner.occurrences,
    ...overview.agentOps.occurrences,
  ].filter((o) => (domain ? o.domain === domain : true));
  const normalized = normalizeTitle(target);

  // Exact ID match
  const byId = all.find((o) => o.id === target);
  if (byId) return { match: byId, ambiguousCandidates: [] };

  // Exact normalized-title match
  const exactMatches = all.filter(
    (o) => normalizeTitle(o.title) === normalized,
  );
  if (exactMatches.length === 1) {
    return { match: exactMatches.at(0) ?? null, ambiguousCandidates: [] };
  }
  if (exactMatches.length > 1) {
    const narrowedMatches = narrowOccurrenceCandidates(exactMatches);
    if (narrowedMatches.length === 1) {
      return { match: narrowedMatches.at(0) ?? null, ambiguousCandidates: [] };
    }
    return {
      match: null,
      ambiguousCandidates: narrowedMatches.map(
        formatOccurrenceDisambiguationLabel,
      ),
    };
  }

  // Substring matches — disambiguate when multiple
  const substringMatches = all.filter((o) =>
    normalizeTitle(o.title).includes(normalized),
  );
  if (substringMatches.length === 1) {
    return { match: substringMatches.at(0) ?? null, ambiguousCandidates: [] };
  }
  if (substringMatches.length > 1) {
    const narrowedSubstringMatches =
      narrowOccurrenceCandidates(substringMatches);
    if (narrowedSubstringMatches.length === 1) {
      return {
        match: narrowedSubstringMatches.at(0) ?? null,
        ambiguousCandidates: [],
      };
    }
    // Prefer startsWith over generic includes
    const startsWithMatches = narrowedSubstringMatches.filter((o) =>
      normalizeTitle(o.title).startsWith(normalized),
    );
    if (startsWithMatches.length === 1) {
      return {
        match: startsWithMatches.at(0) ?? null,
        ambiguousCandidates: [],
      };
    }
    if (startsWithMatches.length > 1) {
      return {
        match: null,
        ambiguousCandidates: startsWithMatches.map(
          formatOccurrenceDisambiguationLabel,
        ),
      };
    }
    // Still ambiguous — return candidates for the caller to list
    return {
      match: null,
      ambiguousCandidates: narrowedSubstringMatches.map(
        formatOccurrenceDisambiguationLabel,
      ),
    };
  }

  const targetTokens = normalized.split(/\s+/).filter(Boolean);
  if (targetTokens.length > 1) {
    const tokenSetMatches = all.filter((occurrence) => {
      const occurrenceTokens = new Set(
        normalizeTitle(occurrence.title).split(/\s+/).filter(Boolean),
      );
      return targetTokens.every((token) => occurrenceTokens.has(token));
    });
    if (tokenSetMatches.length === 1) {
      return { match: tokenSetMatches.at(0) ?? null, ambiguousCandidates: [] };
    }
    if (tokenSetMatches.length > 1) {
      const narrowedTokenSetMatches =
        narrowOccurrenceCandidates(tokenSetMatches);
      if (narrowedTokenSetMatches.length === 1) {
        return {
          match: narrowedTokenSetMatches.at(0) ?? null,
          ambiguousCandidates: [],
        };
      }
      return {
        match: null,
        ambiguousCandidates: narrowedTokenSetMatches.map(
          formatOccurrenceDisambiguationLabel,
        ),
      };
    }
  }

  return { match: null, ambiguousCandidates: [] };
}

function deriveOccurrenceTargetFromIntent(
  intent: string,
  operation: LifeOperation,
): string | null {
  const normalized = normalizeLifeInputText(intent);
  if (!normalized) {
    return null;
  }

  let candidate = normalized;
  if (operation === "snooze") {
    candidate = candidate
      .replace(
        /^(?:please\s+)?(?:snooze|postpone|push\b.*\bback|remind me later about)\s+/i,
        "",
      )
      .replace(/\bfor\s+\d+\s*(?:minutes?|hours?)\b.*$/i, "")
      .replace(/\b(?:until|til)\b.+$/i, "")
      .trim();
  } else if (operation === "skip") {
    candidate = candidate
      .replace(/^(?:please\s+)?(?:skip|pass on)\s+/i, "")
      .replace(/\b(?:today|tonight|for now)\b.*$/i, "")
      .trim();
  } else if (operation === "complete") {
    candidate = candidate
      .replace(
        /^(?:please\s+)?(?:mark\s+|i(?:'ve| have)?\s+|just\s+)?(?:done|completed|finished|did)\s+/i,
        "",
      )
      .replace(/\b(?:done|complete|completed|finished)\b.*$/i, "")
      .trim();
  }

  return candidate.length > 0 ? candidate : null;
}

async function resolveOccurrenceWithIntentFallback(args: {
  service: LifeOpsService;
  target: string | undefined;
  domain?: LifeOpsDomain;
  intent: string;
  operation: LifeOperation;
}): Promise<OccurrenceResult> {
  const direct = await resolveOccurrence(
    args.service,
    args.target,
    args.domain,
  );
  if (direct.match || direct.ambiguousCandidates.length > 0) {
    return direct;
  }

  const fallbackTarget = deriveOccurrenceTargetFromIntent(
    args.intent,
    args.operation,
  );
  if (
    !fallbackTarget ||
    (args.target &&
      normalizeTitle(fallbackTarget) === normalizeTitle(args.target))
  ) {
    return direct;
  }

  return resolveOccurrence(args.service, fallbackTarget, args.domain);
}

function summarizeCadence(cadence: LifeOpsCadence): string {
  const cadenceWindows = Array.isArray(
    (cadence as { windows?: unknown }).windows,
  )
    ? ((cadence as { windows: string[] }).windows ?? []).filter(
        (windowName) =>
          typeof windowName === "string" && windowName.trim().length > 0,
      )
    : [];

  switch (cadence.kind) {
    case "once": {
      const dueAt = new Date(cadence.dueAt);
      if (Number.isNaN(dueAt.getTime())) {
        return "once";
      }
      return `once on ${dueAt.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: resolveDefaultTimeZone(),
      })}`;
    }
    case "daily":
      return cadenceWindows.length > 0
        ? `every day in ${cadenceWindows.join(", ")}`
        : "every day";
    case "times_per_day":
      return cadence.slots
        .map((slot) => slot.label.trim() || `${slot.minuteOfDay}`)
        .filter(Boolean)
        .join(" and ");
    case "interval":
      return cadenceWindows.length > 0
        ? `every ${cadence.everyMinutes} minutes in ${cadenceWindows.join(", ")}`
        : `every ${cadence.everyMinutes} minutes`;
    case "weekly":
      return `weekly on ${cadence.weekdays
        .map(
          (weekday) =>
            [
              "Sunday",
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
            ][weekday] ?? String(weekday),
        )
        .join(", ")}`;
  }
}

type LifeReplyScenario =
  | "reply_only"
  | "clarify_create_definition"
  | "clarify_create_goal"
  | "preview_definition"
  | "saved_definition"
  | "preview_goal"
  | "saved_goal"
  | "updated_definition"
  | "updated_goal"
  | "deleted_definition"
  | "deleted_goal"
  | "completed_occurrence"
  | "skipped_occurrence"
  | "snoozed_occurrence"
  | "overview"
  | "calendar_today"
  | "calendar_next"
  | "email_triage"
  | "weekly_goal_review"
  | "service_error";

function buildRuleBasedLifeReply(args: {
  scenario: LifeReplyScenario;
  intent: string;
  fallback: string;
  context?: Record<string, unknown>;
}): string {
  const context = args.context ?? {};
  const updated =
    context.updated && typeof context.updated === "object"
      ? (context.updated as Record<string, unknown>)
      : null;
  const created =
    context.created && typeof context.created === "object"
      ? (context.created as Record<string, unknown>)
      : null;
  const title =
    (typeof updated?.title === "string" ? updated.title : null) ??
    (typeof created?.title === "string" ? created.title : null) ??
    (typeof context.title === "string" ? context.title : null) ??
    null;
  // Time-phrase nuance ("mornings now", "7pm now", etc.) is rendered by the
  // LLM in renderGroundedActionReply via the additionalRules contract. The
  // rule-based fallback intentionally only carries the title — never tries
  // to parse English-only time phrases out of the intent.

  switch (args.scenario) {
    case "updated_definition":
      if (title) {
        return `${title} is updated.`;
      }
      break;
    case "deleted_definition":
      if (title) {
        return `${title} is off your list.`;
      }
      break;
    case "deleted_goal":
      if (title) {
        return `${title} is off your goals list.`;
      }
      break;
    case "completed_occurrence":
      if (title) {
        return `Marked ${title} done.`;
      }
      break;
    case "skipped_occurrence":
      if (title) {
        return `Okay, skipping ${title} for now.`;
      }
      break;
    case "snoozed_occurrence":
      if (title) {
        return `Okay, I'll bring ${title} back a bit later.`;
      }
      break;
    default:
      break;
  }

  return args.fallback;
}

async function renderLifeActionReply(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  scenario: LifeReplyScenario;
  fallback: string;
  context?: Record<string, unknown>;
}): Promise<string> {
  const { runtime, message, state, intent, scenario, fallback, context } = args;
  const naturalFallback = buildRuleBasedLifeReply({
    scenario,
    intent,
    fallback,
    context,
  });
  const rendered = await renderGroundedActionReply({
    runtime,
    message,
    state,
    intent,
    domain: "lifeops",
    scenario,
    fallback: naturalFallback,
    context,
    preferCharacterVoice: true,
    additionalRules: [
      "Mirror the user's phrasing for time and date when possible.",
      "Prefer phrases like tomorrow morning, every night, 7 am, or the user's own wording over robotic schedule language.",
      "Never surface raw ISO timestamps unless the user used raw ISO timestamps.",
      "If this is a preview, make clear it is not saved yet and the user can confirm or change it naturally.",
      "If this is reply-only, do not pretend you saved or changed anything.",
    ],
  });
  return rendered.trim().length > 0 ? rendered : naturalFallback;
}

function buildLifeClarificationFallback(args: {
  missing: ExtractedLifeMissingField[];
  operation: LifeOperation | null;
  kind: LifeKind | undefined;
}): string {
  const missing = new Set(args.missing);
  if (args.operation === "create" && args.kind === "goal") {
    return "What do you want the goal to be?";
  }
  if (missing.has("title") && missing.has("schedule")) {
    return "What do you want the todo to be, and when should it happen?";
  }
  if (missing.has("title")) {
    return "What do you want it to be?";
  }
  if (missing.has("schedule")) {
    return "When should it happen?";
  }
  return "Tell me a bit more about what you want to set up.";
}

function buildLifeServiceErrorFallback(
  error: LifeOpsServiceError,
  intent: string,
): string {
  const normalized = error.message.toLowerCase();
  if (
    normalized.includes("utc 'z' suffix") ||
    normalized.includes("local datetime without 'z'") ||
    normalized.includes("time didn't parse") ||
    normalized.includes("invalid dueat") ||
    normalized.includes("cadence.dueat")
  ) {
    return `I couldn't pin down the reminder time from "${intent}". Tell me the time again in plain language, like "Friday at 8 pm Pacific."`;
  }
  if (
    normalized.includes("when windowpreset is not provided") ||
    normalized.includes("startat is required")
  ) {
    return "I still need the time for that reminder. Tell me when it should happen.";
  }
  if (error.status === 429 || normalized.includes("rate limit")) {
    return "LifeOps is rate-limited right now. Try again in a bit.";
  }
  return "I couldn't finish that LifeOps change yet. Tell me the task and timing again, and I'll try it a different way.";
}

type LifeConnectedQueryOperation =
  | "query_calendar_today"
  | "query_calendar_next"
  | "query_email";

/**
 * Serves the read-only connected-account queries (today's calendar, next
 * event, email triage). Availability is decided by the real Google capability
 * snapshot from `lifeops/access.ts` — plus `listCalendars` for Apple-native
 * calendars — so connected owners get their data and only genuinely
 * unconnected owners get a refusal. Exported for direct unit testing with a
 * stubbed service.
 */
export async function runLifeConnectedQuery(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  service: LifeOpsService;
  queryOperation: LifeConnectedQueryOperation;
  actionName: string;
}): Promise<ActionResult> {
  const {
    runtime,
    message,
    state,
    intent,
    service,
    queryOperation,
    actionName,
  } = args;
  try {
    const google = await getGoogleCapabilityStatus(service);
    if (queryOperation === "query_email") {
      if (!google.hasGmailTriage) {
        return {
          success: false,
          text: gmailReadUnavailableMessage(google),
          data: { actionName, operation: queryOperation },
        };
      }
      const feed = await service.getGmailTriage(INTERNAL_URL);
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "email_triage",
          fallback: formatEmailTriage(feed),
          context: {
            unreadCount: feed.summary.unreadCount,
            importantNewCount: feed.summary.importantNewCount,
            likelyReplyNeededCount: feed.summary.likelyReplyNeededCount,
            subjects: feed.messages.slice(0, 8).map((entry) => entry.subject),
          },
        }),
        data: toActionData(feed),
      };
    }
    const hasCalendarAccess =
      google.hasCalendarRead ||
      (await service.listCalendars(INTERNAL_URL)).length > 0;
    if (!hasCalendarAccess) {
      return {
        success: false,
        text: calendarReadUnavailableMessage(google),
        data: { actionName, operation: queryOperation },
      };
    }
    if (queryOperation === "query_calendar_next") {
      const next = await service.getNextCalendarEventContext(INTERNAL_URL);
      const fallback = next.event
        ? `Next up: "${next.event.title}" — ${formatCalendarEventDateTime(
            next.event,
            { includeTimeZoneName: true },
          )}${next.location ? ` at ${next.location}` : ""}.`
        : "No upcoming events on your calendar.";
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "calendar_next",
          fallback,
          context: {
            title: next.event?.title ?? null,
            startsAt: next.startsAt,
            startsInMinutes: next.startsInMinutes,
            location: next.location,
            attendeeNames: next.attendeeNames.slice(0, 5),
          },
        }),
        data: toActionData(next),
      };
    }
    const feed = await service.getCalendarFeed(INTERNAL_URL, {
      ...dayRange(0),
      timeZone: resolveDefaultTimeZone(),
    });
    const fallback =
      feed.events.length === 0
        ? "Your calendar is clear today."
        : [
            `You have ${feed.events.length} event${
              feed.events.length === 1 ? "" : "s"
            } today:`,
            ...feed.events.map(
              (event) =>
                `- ${event.title} (${formatCalendarEventDateTime(event)})`,
            ),
          ].join("\n");
    return {
      success: true,
      text: await renderLifeActionReply({
        runtime,
        message,
        state,
        intent,
        scenario: "calendar_today",
        fallback,
        context: {
          eventCount: feed.events.length,
          eventTitles: feed.events.slice(0, 10).map((event) => event.title),
        },
      }),
      data: toActionData(feed),
    };
  } catch (err) {
    if (err instanceof LifeOpsServiceError) {
      return {
        success: false,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "service_error",
          fallback: buildLifeServiceErrorFallback(err, intent),
          context: { status: err.status, operation: queryOperation },
        }),
        data: { actionName, operation: queryOperation },
      };
    }
    throw err;
  }
}

// ── Calendar/email formatters ─────────────────────────

const DEFAULT_WINDOW_SLOT_TIMES: Record<
  "morning" | "afternoon" | "evening" | "night",
  { minuteOfDay: number; durationMinutes: number; label: string }
> = {
  morning: {
    minuteOfDay: 8 * 60,
    durationMinutes: 45,
    label: "Morning",
  },
  afternoon: {
    minuteOfDay: 13 * 60,
    durationMinutes: 45,
    label: "Afternoon",
  },
  evening: {
    minuteOfDay: 18 * 60,
    durationMinutes: 45,
    label: "Evening",
  },
  night: {
    minuteOfDay: 21 * 60,
    durationMinutes: 45,
    label: "Night",
  },
};

function buildSlotsFromWindows(
  windows: Array<"morning" | "afternoon" | "evening" | "night">,
): LifeOpsDailySlot[] {
  return windows.map((window, index) => {
    const preset = DEFAULT_WINDOW_SLOT_TIMES[window];
    return {
      key:
        windows.indexOf(window) === index ? window : `${window}-${index + 1}`,
      label: preset.label,
      minuteOfDay: preset.minuteOfDay,
      durationMinutes: preset.durationMinutes,
    };
  });
}

function buildDistributedDailySlots(count: number): LifeOpsDailySlot[] {
  const normalizedCount = Math.max(1, Math.min(6, count));
  let minutes: number[];
  switch (normalizedCount) {
    case 1:
      minutes = [9 * 60];
      break;
    case 2:
      minutes = [8 * 60, 21 * 60];
      break;
    case 3:
      minutes = [8 * 60, 13 * 60, 20 * 60];
      break;
    case 4:
      minutes = [8 * 60, 12 * 60, 16 * 60, 20 * 60];
      break;
    case 5:
      minutes = [8 * 60, 11 * 60, 14 * 60, 17 * 60, 20 * 60];
      break;
    default:
      minutes = [8 * 60, 10 * 60, 12 * 60, 14 * 60, 17 * 60, 20 * 60];
      break;
  }
  return minutes.map((minuteOfDay, index) => ({
    key: `slot-${index + 1}`,
    label: `Time ${index + 1}`,
    minuteOfDay,
    durationMinutes: 45,
  }));
}

function inferWindowFromMinuteOfDay(
  minuteOfDay: number,
): "morning" | "afternoon" | "evening" | "night" {
  if (minuteOfDay < 12 * 60) {
    return "morning";
  }
  if (minuteOfDay < 17 * 60) {
    return "afternoon";
  }
  if (minuteOfDay < 21 * 60) {
    return "evening";
  }
  return "night";
}

function buildSingleDailySlot(
  minuteOfDay: number,
  durationMinutes = 45,
): LifeOpsDailySlot {
  return {
    key: `time-${minuteOfDay}`,
    label: formatMinuteOfDayLabel(minuteOfDay),
    minuteOfDay,
    durationMinutes,
  };
}

function buildCustomTimeWindowPolicy(
  minuteOfDay: number,
  timeZone: string,
): LifeOpsWindowPolicy {
  const basePolicy = resolveDefaultWindowPolicy(timeZone);
  return {
    timezone: basePolicy.timezone,
    windows: [
      ...basePolicy.windows,
      {
        name: "custom",
        label: formatMinuteOfDayLabel(minuteOfDay),
        startMinute: minuteOfDay,
        endMinute: Math.min(minuteOfDay + 1, 24 * 60),
      },
    ],
  };
}

function formatMinuteOfDayLabel(minuteOfDay: number): string {
  const hour24 = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const meridiem = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return minute === 0
    ? `${hour12}${meridiem}`
    : `${hour12}:${String(minute).padStart(2, "0")}${meridiem}`;
}

function parseClockToken(token: string): number | null {
  const normalized = token.trim().toLowerCase();
  if (normalized === "noon") {
    return 12 * 60;
  }
  if (normalized === "midnight") {
    return 0;
  }
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute >= 60) {
    return null;
  }
  if (hour < 1 || hour > 12) {
    return null;
  }
  const meridiem = match[3];
  const normalizedHour =
    meridiem === "am" ? hour % 12 : hour % 12 === 0 ? 12 : (hour % 12) + 12;
  return normalizedHour * 60 + minute;
}

function parseTimeOfDayToken(token: string): number | null {
  const normalized = normalizeLifeInputText(token).toLowerCase();
  const hhmmMatch = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmmMatch) {
    const hour = Number(hhmmMatch[1]);
    const minute = Number(hhmmMatch[2]);
    if (
      Number.isFinite(hour) &&
      Number.isFinite(minute) &&
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute < 60
    ) {
      return hour * 60 + minute;
    }
  }
  return parseClockToken(normalized);
}

function buildOneOffDueAtFromMinuteOfDay(args: {
  minuteOfDay: number;
  now?: Date;
  timeZone?: string;
}): string {
  const now = args.now ?? new Date();
  const timeZone = args.timeZone ?? resolveDefaultTimeZone();
  const nowParts = getZonedDateParts(now, timeZone);
  let localDate = {
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
  };

  const buildCandidate = () =>
    buildUtcDateFromLocalParts(timeZone, {
      ...localDate,
      hour: Math.floor(args.minuteOfDay / 60),
      minute: args.minuteOfDay % 60,
      second: 0,
    });

  let candidate = buildCandidate();
  if (candidate.getTime() <= now.getTime()) {
    localDate = addDaysToLocalDate(localDate, 1);
    candidate = buildCandidate();
  }

  return candidate.toISOString();
}

/** Default local wall-clock minute for dated one-off tasks without an explicit time (9:00 AM). */
const DEFAULT_ONCE_MINUTE_OF_DAY = 9 * 60;

/**
 * Resolve a one-off dueAt from the LLM-extracted datetime fields, against
 * the owner timezone. Returns null when the request carries no resolvable
 * time expression (or only a past instant) — the caller must then ask the
 * owner to clarify instead of scheduling anything.
 */
export function resolveOnceDueAt(args: {
  dueDate: string | null;
  dueInDays: number | null;
  dueWeekday: number | null;
  dueInMinutes: number | null;
  timeOfDayMinute: number | null;
  now?: Date;
  timeZone?: string;
}): string | null {
  const now = args.now ?? new Date();
  const timeZone = args.timeZone ?? resolveDefaultTimeZone();

  if (args.dueInMinutes !== null && args.dueInMinutes > 0) {
    return new Date(now.getTime() + args.dueInMinutes * 60_000).toISOString();
  }

  const minuteOfDay = args.timeOfDayMinute ?? DEFAULT_ONCE_MINUTE_OF_DAY;
  const buildCandidate = (localDate: {
    year: number;
    month: number;
    day: number;
  }) =>
    buildUtcDateFromLocalParts(timeZone, {
      ...localDate,
      hour: Math.floor(minuteOfDay / 60),
      minute: minuteOfDay % 60,
      second: 0,
    });

  if (args.dueDate) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.dueDate);
    if (!match) {
      return null;
    }
    const candidate = buildCandidate({
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    });
    // A named date already in the past is unresolvable — clarify, don't shift.
    return candidate.getTime() > now.getTime() ? candidate.toISOString() : null;
  }

  const nowParts = getZonedDateParts(now, timeZone);
  const today = {
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
  };

  if (args.dueInDays !== null && args.dueInDays >= 0) {
    const candidate = buildCandidate(addDaysToLocalDate(today, args.dueInDays));
    // "today at 8am" after 8am is unresolvable — clarify, don't roll forward.
    return candidate.getTime() > now.getTime() ? candidate.toISOString() : null;
  }

  if (
    args.dueWeekday !== null &&
    args.dueWeekday >= 0 &&
    args.dueWeekday <= 6
  ) {
    for (let offset = 0; offset <= 7; offset += 1) {
      const localDate = addDaysToLocalDate(today, offset);
      const weekday = new Date(
        Date.UTC(localDate.year, localDate.month - 1, localDate.day, 12),
      ).getUTCDay();
      if (weekday !== args.dueWeekday) {
        continue;
      }
      const candidate = buildCandidate(localDate);
      if (candidate.getTime() > now.getTime()) {
        return candidate.toISOString();
      }
    }
    return null;
  }

  if (args.timeOfDayMinute !== null) {
    return buildOneOffDueAtFromMinuteOfDay({
      minuteOfDay: args.timeOfDayMinute,
      now,
      timeZone,
    });
  }

  return null;
}

// Canonical comparison key for a cadence: deep key-sorted JSON, so two
// structurally identical cadences compare equal regardless of construction
// order. Used only by the duplicate-create guard.
function stableCadenceKey(cadence: unknown): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        if (record[key] === undefined) continue;
        // Visibility lead/lag are scheduling presentation hints, not item
        // identity — a re-call that adds a lead-up shape must still hit the
        // content-duplicate guard.
        if (key === "visibilityLeadMinutes" || key === "visibilityLagMinutes")
          continue;
        out[key] = canonicalize(record[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(canonicalize(cadence));
}

function mergeMetadataRecords(
  ...records: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const merged = Object.assign(
    {},
    ...records.filter(
      (record): record is Record<string, unknown> =>
        record != null && Object.keys(record).length > 0,
    ),
  );
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// A clock token under a preceding negation cue in the same clause is an
// EXCLUDED time ("no 8am/9am reminders", "do not set me a 9am ping"), not a
// requested slot. Clause scope resets at sentence boundaries and at
// contrastive connectives, so "no mornings, but 9pm works" still yields 9pm.
// "don't forget" is an idiom that AFFIRMS the following time, hence the
// lookahead carve-out.
const NEGATED_CLOCK_CUE_RE =
  /\b(?:no|not|don'?t|do\s+not|never|avoid|without|skip|drop|stop|instead\s+of|rather\s+than|none\s+of)\b(?!\s+forget\b)/i;
const CLOCK_CLAUSE_BOUNDARY_RE = /[.;!?\n—–]|\bbut\b/gi;

function clockClauseStart(intent: string, tokenStart: number): number {
  let clauseStart = 0;
  for (const boundary of intent.matchAll(CLOCK_CLAUSE_BOUNDARY_RE)) {
    if (boundary.index >= tokenStart) {
      break;
    }
    clauseStart = boundary.index + boundary[0].length;
  }
  return clauseStart;
}

function clockTokenIsNegated(intent: string, tokenStart: number): boolean {
  return NEGATED_CLOCK_CUE_RE.test(
    intent.slice(clockClauseStart(intent, tokenStart), tokenStart),
  );
}

// "due thursday at 5pm" names the DEADLINE, not a work slot — storing it as a
// daily slot schedules the work session exactly at the due instant (#16941
// live, night-owl: the saved plan's 17:00 slot coincided with the deadline).
const DEADLINE_CLOCK_CONTEXT_RE =
  /\b(?:due|deadline|submit(?:ted)?\s+by|turn(?:\s+it)?\s+in\s+by|hand(?:\s+it)?\s+in\s+by)\b[^.!?\n;]*$/i;

function clockTokenIsDeadline(intent: string, tokenStart: number): boolean {
  return DEADLINE_CLOCK_CONTEXT_RE.test(
    intent.slice(clockClauseStart(intent, tokenStart), tokenStart),
  );
}

// Owner-vocabulary day anchors that carry a concrete time but never match the
// numeric clock pattern ("citations after dinner", "again late evening").
// Conservative midpoints; negation/deadline scoping applies the same way.
const PHRASE_SLOT_MINUTES: ReadonlyArray<[RegExp, number]> = [
  [/\bafter\s+dinner\b/gi, 19 * 60 + 30],
  [/\bafter\s+lunch\b/gi, 13 * 60 + 30],
  [/\bafter\s+school\b/gi, 15 * 60 + 30],
  [/\blate\s+(?:evening|night)\b/gi, 21 * 60 + 30],
  [/\bbefore\s+bed(?:time)?\b/gi, 21 * 60 + 30],
];

function extractExplicitDailySlots(intent: string): LifeOpsDailySlot[] {
  const tokens: Array<{ label: string; minuteOfDay: number }> = [];
  for (const match of intent.matchAll(
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight)\b/gi,
  )) {
    const token = match[1];
    if (typeof token !== "string" || token.length === 0) {
      continue;
    }
    if (
      clockTokenIsNegated(intent, match.index) ||
      clockTokenIsDeadline(intent, match.index)
    ) {
      continue;
    }
    const minuteOfDay = parseClockToken(token);
    if (minuteOfDay !== null) {
      tokens.push({ label: token.trim(), minuteOfDay });
    }
  }
  for (const [phraseRe, minuteOfDay] of PHRASE_SLOT_MINUTES) {
    for (const match of intent.matchAll(phraseRe)) {
      if (
        clockTokenIsNegated(intent, match.index) ||
        clockTokenIsDeadline(intent, match.index)
      ) {
        continue;
      }
      tokens.push({ label: match[0].trim().toLowerCase(), minuteOfDay });
    }
  }
  const seen = new Set<number>();
  const slots: LifeOpsDailySlot[] = [];
  for (const [index, token] of tokens.entries()) {
    if (seen.has(token.minuteOfDay)) {
      continue;
    }
    seen.add(token.minuteOfDay);
    slots.push({
      key: `clock-${index + 1}`,
      label: token.label,
      minuteOfDay: token.minuteOfDay,
      durationMinutes: 45,
    });
  }
  return slots.sort((left, right) => left.minuteOfDay - right.minuteOfDay);
}

function normalizeLifeWindows(
  value: unknown,
): Array<"morning" | "afternoon" | "evening" | "night"> {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const normalized = values.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const lower = normalizeLifeInputText(entry).toLowerCase();
    if (lower === "morning") return ["morning" as const];
    if (lower === "afternoon") return ["afternoon" as const];
    if (lower === "evening") return ["evening" as const];
    if (lower === "night") return ["night" as const];
    return [];
  });
  return [...new Set(normalized)];
}

function normalizeCadenceDetail(value: unknown): LifeOpsCadence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const cadenceKind =
    typeof record.kind === "string"
      ? normalizeLifeInputText(record.kind).toLowerCase()
      : typeof record.type === "string"
        ? normalizeLifeInputText(record.type).toLowerCase()
        : "";

  if (!cadenceKind) {
    return undefined;
  }

  if (cadenceKind === "once" && typeof record.dueAt === "string") {
    return {
      kind: "once",
      dueAt: record.dueAt,
    };
  }

  if (cadenceKind === "interval") {
    const everyMinutes =
      typeof record.everyMinutes === "number"
        ? record.everyMinutes
        : typeof record.everyMinutes === "string"
          ? Number(record.everyMinutes)
          : typeof record.minutes === "number"
            ? record.minutes
            : typeof record.minutes === "string"
              ? Number(record.minutes)
              : NaN;
    if (Number.isFinite(everyMinutes) && everyMinutes > 0) {
      return {
        kind: "interval",
        everyMinutes,
        windows: normalizeLifeWindows(record.windows),
      };
    }
    return undefined;
  }

  if (cadenceKind === "weekly") {
    const weekdays = Array.isArray(record.weekdays)
      ? record.weekdays
          .map((entry) =>
            typeof entry === "number"
              ? entry
              : typeof entry === "string"
                ? Number(entry)
                : NaN,
          )
          .filter((entry) => Number.isFinite(entry))
      : [];
    if (weekdays.length > 0) {
      return {
        kind: "weekly",
        weekdays,
        windows: normalizeLifeWindows(record.windows),
      };
    }
    return undefined;
  }

  const explicitTimes = Array.isArray(record.times)
    ? record.times
        .map((entry) =>
          typeof entry === "string" ? parseTimeOfDayToken(entry) : null,
        )
        .filter((entry): entry is number => entry !== null)
    : [];
  if (explicitTimes.length > 0) {
    return {
      kind: "times_per_day",
      slots: explicitTimes.map((minuteOfDay, index) => ({
        key: `time-${index + 1}`,
        label: formatMinuteOfDayLabel(minuteOfDay),
        minuteOfDay,
        durationMinutes: 45,
      })),
      visibilityLeadMinutes: 90,
      visibilityLagMinutes: 180,
    };
  }

  if (cadenceKind === "times_per_day") {
    if (Array.isArray(record.slots)) {
      const slots = record.slots
        .map((entry, index) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return null;
          }
          const slot = entry as Record<string, unknown>;
          const minuteOfDay =
            typeof slot.minuteOfDay === "number"
              ? slot.minuteOfDay
              : typeof slot.minuteOfDay === "string"
                ? Number(slot.minuteOfDay)
                : null;
          if (minuteOfDay === null || !Number.isFinite(minuteOfDay)) {
            return null;
          }
          return {
            key:
              typeof slot.key === "string" && slot.key.trim().length > 0
                ? slot.key
                : `slot-${index + 1}`,
            label:
              typeof slot.label === "string" && slot.label.trim().length > 0
                ? slot.label
                : formatMinuteOfDayLabel(minuteOfDay),
            minuteOfDay,
            durationMinutes:
              typeof slot.durationMinutes === "number" &&
              Number.isFinite(slot.durationMinutes) &&
              slot.durationMinutes > 0
                ? slot.durationMinutes
                : 45,
          } satisfies LifeOpsDailySlot;
        })
        .filter((entry): entry is LifeOpsDailySlot => entry !== null);
      if (slots.length > 0) {
        return {
          kind: "times_per_day",
          slots,
          visibilityLeadMinutes:
            typeof record.visibilityLeadMinutes === "number"
              ? record.visibilityLeadMinutes
              : 90,
          visibilityLagMinutes:
            typeof record.visibilityLagMinutes === "number"
              ? record.visibilityLagMinutes
              : 180,
        };
      }
    }

    const count =
      typeof record.count === "number"
        ? record.count
        : typeof record.count === "string"
          ? Number(record.count)
          : NaN;
    if (Number.isFinite(count) && count > 0) {
      return {
        kind: "times_per_day",
        slots: buildDistributedDailySlots(count),
        visibilityLeadMinutes: 90,
        visibilityLagMinutes: 180,
      };
    }
  }

  if (cadenceKind === "daily") {
    const windows = normalizeLifeWindows(record.windows ?? record.window);
    if (windows.length > 0) {
      return {
        kind: "daily",
        windows,
      };
    }
    return {
      kind: "daily",
      windows: ["morning"],
    };
  }

  return undefined;
}

/**
 * Convert LLM-extracted params into a typed LifeOpsCadence.
 * Returns null when the LLM output is insufficient to construct a
 * valid cadence — for "once" that means no resolvable time expression,
 * and the caller asks the owner to clarify instead of scheduling.
 */
export function buildCadenceFromLlmParams(
  params: ExtractedTaskParams,
  context?: {
    intent?: string;
    now?: Date;
    timeZone?: string;
  },
): {
  cadence: LifeOpsCadence;
  windowPolicy?: CreateLifeOpsDefinitionRequest["windowPolicy"];
} | null {
  const kind = params.cadenceKind;
  if (!kind) return null;
  const effectiveTimeZone = context?.timeZone;
  const timeOfDayMinute =
    typeof params.timeOfDay === "string"
      ? parseTimeOfDayToken(params.timeOfDay)
      : null;
  const explicitSlots =
    typeof context?.intent === "string"
      ? extractExplicitDailySlots(context.intent)
      : [];
  const slotDuration =
    typeof params.durationMinutes === "number" && params.durationMinutes > 0
      ? params.durationMinutes
      : 45;

  const windows = (params.windows ?? []).filter(
    (w): w is "morning" | "afternoon" | "evening" | "night" =>
      w === "morning" || w === "afternoon" || w === "evening" || w === "night",
  );
  const effectiveWindows =
    windows.length > 0
      ? windows
      : timeOfDayMinute !== null
        ? [inferWindowFromMinuteOfDay(timeOfDayMinute)]
        : ["morning" as const];

  if (kind === "once") {
    const dueAt = resolveOnceDueAt({
      dueDate: params.dueDate,
      dueInDays: params.dueInDays,
      dueWeekday: params.dueWeekday,
      dueInMinutes: params.dueInMinutes,
      timeOfDayMinute,
      now: context?.now,
      timeZone: effectiveTimeZone,
    });
    // No resolvable time expression — never fabricate an immediate dueAt.
    return dueAt ? { cadence: { kind: "once", dueAt } } : null;
  }
  if (kind === "daily") {
    if (explicitSlots.length >= 2) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: explicitSlots.map((slot) => ({
            ...slot,
            durationMinutes: slot.durationMinutes,
          })),
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: [buildSingleDailySlot(timeOfDayMinute, slotDuration)],
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    if (effectiveWindows.length >= 2) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: buildSlotsFromWindows(effectiveWindows),
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    return { cadence: { kind: "daily", windows: effectiveWindows } };
  }
  if (kind === "weekly") {
    const weekdays = params.weekdays;
    if (!weekdays || weekdays.length === 0) return null;
    if (timeOfDayMinute !== null) {
      return {
        cadence: { kind: "weekly", weekdays, windows: ["custom"] },
        windowPolicy: buildCustomTimeWindowPolicy(
          timeOfDayMinute,
          effectiveTimeZone ?? resolveDefaultTimeZone(),
        ),
      };
    }
    return { cadence: { kind: "weekly", weekdays, windows: effectiveWindows } };
  }
  if (kind === "interval") {
    const everyMinutes = params.everyMinutes;
    if (!everyMinutes || everyMinutes <= 0) return null;
    return {
      cadence: {
        kind: "interval",
        everyMinutes,
        windows: effectiveWindows,
        startMinuteOfDay: timeOfDayMinute ?? undefined,
        durationMinutes:
          typeof params.durationMinutes === "number" &&
          params.durationMinutes > 0
            ? params.durationMinutes
            : undefined,
      },
    };
  }
  if (kind === "times_per_day") {
    if (explicitSlots.length >= 2) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: explicitSlots.map((slot) => ({
            ...slot,
            durationMinutes: slot.durationMinutes,
          })),
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: [buildSingleDailySlot(timeOfDayMinute, slotDuration)],
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    const count = params.timesPerDay;
    if (!count || count <= 0) return null;
    return {
      cadence: {
        kind: "times_per_day",
        slots: buildDistributedDailySlots(count).map((slot) => ({
          ...slot,
          durationMinutes: slotDuration,
        })),
        visibilityLeadMinutes: 90,
        visibilityLagMinutes: 180,
      },
    };
  }
  return null;
}

export function buildCadenceFromUpdateFields(args: {
  currentCadence: LifeOpsCadence;
  currentWindowPolicy: LifeOpsWindowPolicy;
  update: ExtractedUpdateFields;
  timeZone: string;
  /** Clock override for tests; defaults to the system clock. */
  now?: Date;
}): {
  cadence: LifeOpsCadence;
  windowPolicy?: UpdateLifeOpsDefinitionRequest["windowPolicy"];
} | null {
  const { currentCadence, currentWindowPolicy, timeZone, update } = args;
  const kind = (update.cadenceKind ??
    currentCadence.kind) as LifeOpsCadence["kind"];
  const requestedWindows = normalizeLifeWindows(update.windows ?? []);
  const timeOfDayMinute =
    typeof update.timeOfDay === "string"
      ? parseTimeOfDayToken(update.timeOfDay)
      : null;

  if (kind === "interval") {
    const everyMinutes =
      update.everyMinutes ??
      (currentCadence.kind === "interval" ? currentCadence.everyMinutes : null);
    if (!everyMinutes || everyMinutes <= 0) {
      return null;
    }
    const windows: Array<"morning" | "afternoon" | "evening" | "night"> =
      requestedWindows.length > 0
        ? requestedWindows
        : currentCadence.kind === "interval" &&
            currentCadence.windows.length > 0
          ? normalizeLifeWindows(currentCadence.windows)
          : timeOfDayMinute !== null
            ? [inferWindowFromMinuteOfDay(timeOfDayMinute)]
            : ["morning"];
    return {
      cadence: {
        kind: "interval",
        everyMinutes,
        windows,
        startMinuteOfDay:
          timeOfDayMinute ??
          (currentCadence.kind === "interval"
            ? currentCadence.startMinuteOfDay
            : undefined),
        maxOccurrencesPerDay:
          currentCadence.kind === "interval"
            ? currentCadence.maxOccurrencesPerDay
            : undefined,
        durationMinutes:
          currentCadence.kind === "interval"
            ? currentCadence.durationMinutes
            : undefined,
        visibilityLeadMinutes:
          currentCadence.kind === "interval"
            ? currentCadence.visibilityLeadMinutes
            : undefined,
        visibilityLagMinutes:
          currentCadence.kind === "interval"
            ? currentCadence.visibilityLagMinutes
            : undefined,
      },
    };
  }

  if (kind === "weekly") {
    const weekdays =
      update.weekdays ??
      (currentCadence.kind === "weekly" ? currentCadence.weekdays : null);
    if (!weekdays || weekdays.length === 0) {
      return null;
    }
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "weekly",
          weekdays,
          windows: ["custom"],
          visibilityLeadMinutes:
            currentCadence.kind === "weekly"
              ? currentCadence.visibilityLeadMinutes
              : undefined,
          visibilityLagMinutes:
            currentCadence.kind === "weekly"
              ? currentCadence.visibilityLagMinutes
              : undefined,
        },
        windowPolicy: buildCustomTimeWindowPolicy(timeOfDayMinute, timeZone),
      };
    }
    return {
      cadence: {
        kind: "weekly",
        weekdays,
        windows:
          requestedWindows.length > 0
            ? requestedWindows
            : currentCadence.kind === "weekly" &&
                currentCadence.windows.length > 0
              ? currentCadence.windows
              : ["morning"],
        visibilityLeadMinutes:
          currentCadence.kind === "weekly"
            ? currentCadence.visibilityLeadMinutes
            : undefined,
        visibilityLagMinutes:
          currentCadence.kind === "weekly"
            ? currentCadence.visibilityLagMinutes
            : undefined,
      },
      windowPolicy: currentWindowPolicy.windows.some((window) =>
        (requestedWindows.length > 0
          ? requestedWindows
          : ["morning" as const]
        ).includes(
          window.name as "morning" | "afternoon" | "evening" | "night",
        ),
      )
        ? undefined
        : resolveDefaultWindowPolicy(timeZone),
    };
  }

  if (kind === "daily") {
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: [buildSingleDailySlot(timeOfDayMinute)],
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    return {
      cadence: {
        kind: "daily",
        windows:
          requestedWindows.length > 0
            ? requestedWindows
            : currentCadence.kind === "daily" &&
                currentCadence.windows.length > 0
              ? currentCadence.windows
              : ["morning"],
        visibilityLeadMinutes:
          currentCadence.kind === "daily"
            ? currentCadence.visibilityLeadMinutes
            : undefined,
        visibilityLagMinutes:
          currentCadence.kind === "daily"
            ? currentCadence.visibilityLagMinutes
            : undefined,
      },
    };
  }

  if (kind === "times_per_day") {
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: [buildSingleDailySlot(timeOfDayMinute)],
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    if (requestedWindows.length > 0) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: buildSlotsFromWindows(requestedWindows),
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    return currentCadence.kind === "times_per_day"
      ? { cadence: currentCadence }
      : null;
  }

  // once: a date-level move ("push it to Friday", "move it to april 17")
  // and/or an explicit new time moves the dueAt. With neither there is
  // nothing to change — return null so the caller reports that honestly
  // instead of re-saving the old dueAt and claiming an update happened.
  if (kind === "once") {
    const hasDateMove =
      update.dueDate !== null ||
      update.dueInDays !== null ||
      update.dueWeekday !== null ||
      update.dueInMinutes !== null;
    if (hasDateMove) {
      const dueAt = resolveOnceDueAt({
        dueDate: update.dueDate,
        dueInDays: update.dueInDays,
        dueWeekday: update.dueWeekday,
        dueInMinutes: update.dueInMinutes,
        timeOfDayMinute,
        now: args.now,
        timeZone,
      });
      // Unresolvable (e.g. a named date already in the past) — report
      // honestly rather than writing a bogus dueAt.
      return dueAt ? { cadence: { kind: "once", dueAt } } : null;
    }
    if (timeOfDayMinute !== null) {
      const currentDueAt =
        currentCadence.kind === "once" ? new Date(currentCadence.dueAt) : null;
      if (!currentDueAt || !Number.isFinite(currentDueAt.getTime())) {
        return null;
      }
      const currentLocalDate = getZonedDateParts(currentDueAt, timeZone);
      return {
        cadence: {
          kind: "once",
          dueAt: buildUtcDateFromLocalParts(timeZone, {
            year: currentLocalDate.year,
            month: currentLocalDate.month,
            day: currentLocalDate.day,
            hour: Math.floor(timeOfDayMinute / 60),
            minute: timeOfDayMinute % 60,
            second: 0,
          }).toISOString(),
        },
      };
    }
  }
  return null;
}

function hasDefinitionUpdateChanges(
  request: UpdateLifeOpsDefinitionRequest,
): boolean {
  return (
    request.title != null ||
    request.timezone != null ||
    request.cadence != null ||
    request.priority != null ||
    request.description != null ||
    request.windowPolicy != null ||
    request.reminderPlan != null
  );
}

function buildDefaultReminderPlan(
  label: string,
): NonNullable<CreateLifeOpsDefinitionRequest["reminderPlan"]> {
  return {
    steps: [{ channel: "in_app", offsetMinutes: 0, label }],
  };
}

// "bug me before friday too", "remind me earlier as well", "not just friday
// morning" — an explicit ask for a lead-up nudge on top of the due-time
// reminder. Kept as a deterministic detector because the ask arrives inside a
// confirmation turn where extraction focuses on the base item (#16941 live:
// the earlier checkpoint was proposed in prose but never persisted).
const EARLIER_NUDGE_ASK_RE =
  /(?:\b(?:bug|remind|nudge|ping|poke)\s+me\b[^.!?\n]{0,60}\b(?:before|earlier|ahead of|leading up)\b|\bcan\s+it\b[^.!?\n]{0,60}\bbefore\b|\bnot just\b[^.!?\n]{0,40}\b(?:morning|tonight|that day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bearlier\s+(?:nudge|reminder|check[-\s]?in|checkpoint|heads[-\s]?up)\b)/i;

export function wantsEarlierReminderNudge(text: string): boolean {
  return EARLIER_NUDGE_ASK_RE.test(text);
}

/** "-4320" -> "3 days", "-1440" -> "a day", "-90" -> "1.5 hours". */
export function formatLeadOffsetPhrase(offsetMinutes: number): string {
  const minutes = Math.abs(offsetMinutes);
  if (minutes >= 1380 && minutes <= 1500) {
    return "a day";
  }
  if (minutes > 1500) {
    const days = minutes / 1440;
    const rendered =
      days >= 10 || Number.isInteger(days)
        ? String(Math.round(days))
        : days.toFixed(1);
    return `${rendered} days`;
  }
  if (minutes >= 60) {
    const hours = minutes / 60;
    const rendered = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
    return `${rendered} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * Reshapes a dated one-off into the store's lead-up form when the owner asked
 * to be nudged before the due time too. Reminder-plan step offsets must be
 * >= 0 and fire at `relevanceStartAt + offset`, so earliness is expressed by
 * widening the once cadence's `visibilityLeadMinutes` (relevance opens at
 * `dueAt - lead`) and anchoring the early step at offset 0 with the due-time
 * step at `lead`. A first attempt stored negative offsets and the service
 * rightly rejected them (#16941 live: every "bug me before friday too" plan
 * collapsed to a single due-time step).
 */
export function applyLeadUpReminderShape(args: {
  cadence: LifeOpsCadence;
  plan: NonNullable<CreateLifeOpsDefinitionRequest["reminderPlan"]>;
  ownerText: string;
  title: string;
  milestones: string[];
  now?: number;
}): {
  cadence: LifeOpsCadence;
  plan: NonNullable<CreateLifeOpsDefinitionRequest["reminderPlan"]>;
} {
  const unchanged = { cadence: args.cadence, plan: args.plan };
  if (args.cadence.kind !== "once") {
    return unchanged;
  }
  const dueAtMs = Date.parse(args.cadence.dueAt);
  if (!Number.isFinite(dueAtMs)) {
    return unchanged;
  }
  const now = args.now ?? Date.now();
  const runwayMinutes = Math.floor((dueAtMs - now) / 60_000);
  const hasMilestones = args.milestones.length >= 2 && runwayMinutes >= 120;
  const wantsLead =
    wantsEarlierReminderNudge(args.ownerText) && runwayMinutes >= 60;
  if (!hasMilestones && !wantsLead) {
    return unchanged;
  }
  // Already shaped (an explicit lead plus a multi-step ladder) — keep it.
  if (
    (args.cadence.visibilityLeadMinutes ?? 0) >= 60 &&
    args.plan.steps.length >= 2
  ) {
    return unchanged;
  }
  // 15-minute granularity keeps a same-turn planner re-call from minting a
  // slightly different lead and slipping past the content-duplicate guard.
  const quantize = (minutes: number): number => Math.round(minutes / 15) * 15;
  if (hasMilestones) {
    const count = args.milestones.length;
    const lead = Math.max(15, quantize((runwayMinutes * count) / (count + 1)));
    const steps = args.milestones.map((label, index) => ({
      channel: "in_app" as const,
      offsetMinutes: Math.min(
        lead,
        quantize((runwayMinutes * index) / (count + 1)),
      ),
      label,
    }));
    steps.push({
      channel: "in_app",
      offsetMinutes: lead,
      label: `Due: ${args.title}`,
    });
    return {
      cadence: { ...args.cadence, visibilityLeadMinutes: lead },
      plan: { ...args.plan, steps },
    };
  }
  const lead = Math.max(
    15,
    quantize(Math.min(1440, Math.floor(runwayMinutes / 2))),
  );
  return {
    cadence: { ...args.cadence, visibilityLeadMinutes: lead },
    plan: {
      ...args.plan,
      steps: [
        {
          channel: "in_app",
          offsetMinutes: 0,
          label: `Early start: ${args.title}`,
        },
        {
          channel: "in_app",
          offsetMinutes: lead,
          label: `${args.title} reminder`,
        },
      ],
    },
  };
}

/**
 * Minutes before the due instant a plan step fires, given the cadence lead:
 * a step at offset 0 fires at `dueAt - lead`, the step at offset = lead fires
 * at the due time. Non-positive results mean "at (or after) the due time".
 */
export function reminderStepMinutesBeforeDue(
  cadence: LifeOpsCadence,
  offsetMinutes: number,
): number {
  const lead =
    cadence.kind === "once" ? (cadence.visibilityLeadMinutes ?? 15) : 0;
  return lead - offsetMinutes;
}

/**
 * Pulls an enumerated milestone list ("outline, rough draft, and final
 * proofread") out of a multi-milestone create ask. Prefers the segment after
 * a colon, else after "for"; the list ends at the "and X" item or at the
 * first segment that reads like schedule prose rather than a milestone name.
 */
export function parseMilestoneListFromIntent(text: string): string[] {
  const match =
    text.match(/:\s*([^.!?\n]+)/) ?? text.match(/\bfor\b\s+([^.!?\n]+)/i);
  if (!match) {
    return [];
  }
  const items: string[] = [];
  for (const rawPart of match[1].split(/,\s*/)) {
    const isLast = /^and\s+/i.test(rawPart.trim());
    const part = rawPart
      .trim()
      .replace(/^and\s+/i, "")
      .trim();
    if (
      part.length === 0 ||
      part.length > 40 ||
      part.split(/\s+/).length > 5 ||
      /\b(?:due|deadline|ahead|before|by|remind|reminders?)\b/i.test(part)
    ) {
      break;
    }
    items.push(part);
    if (isLast) {
      break;
    }
  }
  return items.length >= 2 ? items : [];
}

function resolveMilestoneLabels(args: {
  details: Record<string, unknown> | undefined;
  intent: string;
  ownerText: string;
  multiStep: boolean;
}): string[] {
  // Planner-supplied steps are trusted directly; intent parsing only runs
  // when extraction itself judged the ask multi-milestone, so a plain
  // comma-separated errand list never becomes a staged plan.
  const fromDetails = (detailArray(args.details, "steps") ?? [])
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .map((value) => value.trim());
  if (fromDetails.length >= 2) {
    return fromDetails;
  }
  if (!args.multiStep) {
    return [];
  }
  const fromIntent = parseMilestoneListFromIntent(args.intent);
  return fromIntent.length >= 2
    ? fromIntent
    : parseMilestoneListFromIntent(args.ownerText);
}

function scoreDefinitionTitleQuality(value: string | null | undefined): number {
  const normalized = normalizeTitle(value ?? "");
  if (!normalized) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = normalized.split(/\s+/).filter(Boolean).length;
  if (/\b\d+\b/.test(normalized)) {
    score += 6;
  }
  if (/[+&]/.test(value ?? "") || /\band\b/.test(normalized)) {
    score += 4;
  }
  if (
    /^(?:do|work out|workout|habit|routine|task|todo|reminder|alarm)\b/.test(
      normalized,
    )
  ) {
    score -= 5;
  }
  if (GENERIC_DERIVED_TITLE_RE.test(normalized)) {
    score -= 6;
  }
  return score;
}

function shouldAdoptPlannerTitle(args: {
  currentTitle: string | null | undefined;
  plannerTitle: string | null | undefined;
}): boolean {
  const plannerTitle = args.plannerTitle?.trim();
  if (!plannerTitle) {
    return false;
  }
  const currentTitle = args.currentTitle?.trim();
  if (!currentTitle) {
    return true;
  }
  if (normalizeTitle(currentTitle) === normalizeTitle(plannerTitle)) {
    return false;
  }
  return (
    scoreDefinitionTitleQuality(plannerTitle) >
    scoreDefinitionTitleQuality(currentTitle)
  );
}

function shouldAdoptPlannerCadence(args: {
  currentCadence: LifeOpsCadence | undefined;
  plannerCadence: LifeOpsCadence;
}): boolean {
  const { currentCadence, plannerCadence } = args;
  if (!currentCadence) {
    return true;
  }
  if (currentCadence.kind === "times_per_day") {
    return (
      (plannerCadence.kind === "times_per_day" &&
        plannerCadence.slots.length >= currentCadence.slots.length) ||
      (plannerCadence.kind === "once" && currentCadence.slots.length === 1)
    );
  }
  if (currentCadence.kind === "weekly") {
    return (
      plannerCadence.kind === "weekly" &&
      plannerCadence.weekdays.length >= currentCadence.weekdays.length &&
      (currentCadence.windows.includes("custom")
        ? plannerCadence.windows.includes("custom")
        : plannerCadence.windows.length >= currentCadence.windows.length)
    );
  }
  if (currentCadence.kind === "interval") {
    return plannerCadence.kind === "interval";
  }
  if (currentCadence.kind === "once") {
    return plannerCadence.kind === "once";
  }
  if (currentCadence.kind === "daily") {
    return (
      plannerCadence.kind === "times_per_day" ||
      (plannerCadence.kind === "daily" &&
        plannerCadence.windows.length >= currentCadence.windows.length)
    );
  }
  return true;
}

function shouldRequireLifeCreateConfirmation(args: {
  confirmed: boolean;
  messageSource: string | undefined;
  requestKind?: NativeAppleReminderLikeKind | null;
  cadence?: LifeOpsCadence;
  multiStep?: boolean;
}): boolean {
  if (args.messageSource === "autonomy") {
    return false;
  }
  // Crisp single dated asks save immediately (#16935); a multi-milestone ask
  // ("reminders for outline, rough draft, and final proofread") collapses into
  // one definition whose derived breakdown the owner has not seen, so it keeps
  // the two-phase preview even when extraction resolved a once cadence
  // (#16941 live finding: the exemption over-triggered and wrote pre-consent).
  if (args.requestKind && args.cadence?.kind === "once" && !args.multiStep) {
    return false;
  }
  return !args.confirmed;
}

function formatGoalExperienceLoopSummary(
  experienceLoop:
    | {
        summary?: string | null;
        similarGoals?: Array<{ title?: string }>;
        suggestedCarryForward?: Array<{ title?: string }>;
      }
    | null
    | undefined,
): string | null {
  if (!experienceLoop?.summary) {
    return null;
  }
  const similarGoalTitle = experienceLoop.similarGoals?.[0]?.title?.trim();
  const carryForwardTitle =
    experienceLoop.suggestedCarryForward?.[0]?.title?.trim();
  const parts = [experienceLoop.summary.trim()];
  if (similarGoalTitle) {
    parts.push(`Closest match: "${similarGoalTitle}".`);
  }
  if (carryForwardTitle) {
    parts.push(`Carry forward "${carryForwardTitle}" if it still fits.`);
  }
  return parts.join(" ");
}

function formatWeeklyGoalReview(args: {
  summary: {
    totalGoals: number;
    onTrackCount: number;
    atRiskCount: number;
    needsAttentionCount: number;
  };
  onTrack: Array<{ goal: { title: string } }>;
  atRisk: Array<{ goal: { title: string } }>;
  needsAttention: Array<{ goal: { title: string } }>;
}): string {
  const parts = [
    `Weekly goal review: ${args.summary.totalGoals} active ${args.summary.totalGoals === 1 ? "goal" : "goals"}, ${args.summary.onTrackCount} on track, ${args.summary.atRiskCount} at risk, ${args.summary.needsAttentionCount} needing attention.`,
  ];
  if (args.atRisk.length > 0) {
    parts.push(
      `Drifting: ${args.atRisk
        .slice(0, 3)
        .map((review) => review.goal.title)
        .join(", ")}.`,
    );
  }
  if (args.needsAttention.length > 0) {
    parts.push(
      `Needs attention: ${args.needsAttention
        .slice(0, 3)
        .map((review) => review.goal.title)
        .join(", ")}.`,
    );
  }
  if (args.onTrack.length > 0) {
    parts.push(
      `On track: ${args.onTrack
        .slice(0, 3)
        .map((review) => review.goal.title)
        .join(", ")}.`,
    );
  }
  return parts.join(" ");
}

// ── Main action ───────────────────────────────────────

// Owner-operation actions belong to the home chat (the non-page-scoped
// assistant surface). On any page-* scope the action set is scoped to that
// surface (page-automations → WORKFLOW, page-browser → browser actions, etc.).
// When owner-operation actions stay eligible on those scopes, their long
// descriptions contaminate the ACTION_PLANNER candidate list, driving the LLM
// to mimic the life-param-extractor structured schema and producing envelopes
// the planner cannot read.
async function isForeignPageScope(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> {
  const room = await runtime.getRoom(message.roomId);
  const metadata = extractConversationMetadataFromRoom(room);
  return isPageScopedConversationMetadata(metadata);
}

// Metadata reused by the owner-* umbrella actions in owner-surfaces.ts.
// The old umbrella is no longer planner-visible — owner-surfaces publishes the
// individual reminder/alarm/goal/task-list/routine umbrellas that delegate into
// `runLifeOperationHandler` below.
export const OWNER_OPERATION_TAGS: string[] = [
  "domain:reminders",
  "capability:read",
  "capability:write",
  "capability:update",
  "capability:delete",
  "capability:schedule",
  "effect:receipt-required",
  "surface:internal",
];

// "productivity" is deliberate: Stage-1 routinely tags habit/reminder-shaped
// asks with the productivity context (a child of tasks). Retrieval uses
// selected contexts as a +0.3 weight, and the tier narrow only keeps parents
// that match a Stage-1 candidate name or score >= 0.97 — without this context
// the owner-life umbrellas lost the boost to SCHEDULED_TASKS (which declares
// productivity) and were never exposed for "brush my teeth at 8 am and 9 pm
// every day" (#10722 brush-teeth-basic live trajectory).
export const OWNER_OPERATION_CONTEXTS: AgentContext[] = [
  "general",
  "tasks",
  "goals",
  "todos",
  "productivity",
  "calendar",
  "health",
];

export const OWNER_OPERATION_ROLE_GATE = { minRole: "OWNER" } as const;
export const OWNER_OPERATION_SUPPRESS_POST_ACTION_CONTINUATION = true;

export const OWNER_OPERATION_VALIDATE = async (
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> => {
  if (await isForeignPageScope(runtime, message)) {
    return false;
  }
  return true;
};

function ownerSurfaceActionNameFromOptions(
  options: HandlerOptions | undefined,
): string {
  const raw = (options as HandlerOptions | undefined)?.parameters as
    | LifeParams
    | undefined;
  return typeof raw?.ownerSurface === "string" && raw.ownerSurface.length > 0
    ? raw.ownerSurface
    : "OWNER_TODOS";
}

function lifeEffectRequestId(message: Memory): string {
  return message.id ?? `room:${message.roomId}`;
}

function lifeEffectObservedAt(
  message: Memory,
  data: Record<string, unknown> | null,
): string {
  const durableObservedAt = data?.mutationObservedAt;
  if (
    typeof durableObservedAt === "string" &&
    Number.isFinite(Date.parse(durableObservedAt))
  ) {
    return durableObservedAt;
  }
  if (message.createdAt !== undefined) {
    return new Date(message.createdAt).toISOString();
  }
  return new Date().toISOString();
}

function lifeEffectReceiptId(
  message: Memory,
  operation: string,
  resourceId: string,
): string {
  return `OWNER_LIFE:${operation}:${lifeEffectRequestId(message)}:${resourceId}`;
}

function lifeEffectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function lifeEffectString(value: unknown, field: string): string | null {
  const record = lifeEffectRecord(value);
  const candidate = record?.[field];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : null;
}

function lifeEffectPreview(message: Memory, operation: string): EffectReceipt {
  const id = lifeEffectRequestId(message);
  return normalizeEffectReceipt({
    receiptId: lifeEffectReceiptId(message, operation, id),
    operation,
    resource: {
      kind: "lifeops.owner_draft",
      id,
    },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt: new Date().toISOString(),
    outcome: "preview",
  });
}

function lifeRequestedOperation(options: HandlerOptions | undefined): string {
  const params = lifeEffectRecord(options?.parameters);
  const raw =
    lifeEffectString(params, "subaction") ??
    lifeEffectString(params, "action") ??
    "resolve";
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

async function latestLifeAudit(args: {
  runtime: IAgentRuntime;
  ownerType: "definition" | "goal" | "occurrence";
  ownerId: string;
  eventTypes: readonly string[];
}) {
  const service = new LifeOpsService(args.runtime);
  const audits = await service.repository.listAuditEvents(
    args.runtime.agentId,
    args.ownerType,
    args.ownerId,
  );
  const audit = audits.find((candidate) =>
    args.eventTypes.includes(candidate.eventType),
  );
  if (!audit) {
    throw new ElizaError(
      `LifeOps ${args.ownerType} mutation committed without matching audit proof`,
      {
        code: "LIFEOPS_EFFECT_AUDIT_REQUIRED",
        context: {
          ownerId: args.ownerId,
          ownerType: args.ownerType,
          eventTypes: args.eventTypes,
        },
        severity: "fatal",
      },
    );
  }
  return audit;
}

function lifeFailureCode(result: ActionResult): string {
  const data = lifeEffectRecord(result.data);
  const values = lifeEffectRecord(result.values);
  return (
    lifeEffectString(data, "error") ??
    lifeEffectString(values, "error") ??
    (data?.missingField ? "LIFEOPS_MISSING_FIELD" : null) ??
    "LIFEOPS_OPERATION_REJECTED"
  );
}

async function lifeEffectReceiptForResult(args: {
  runtime: IAgentRuntime;
  message: Memory;
  options: HandlerOptions | undefined;
  result: ActionResult;
}): Promise<EffectReceipt> {
  const data = lifeEffectRecord(args.result.data);
  const operationHint = lifeRequestedOperation(args.options);
  const operation = `lifeops.owner.${operationHint}`;
  const requestId = lifeEffectRequestId(args.message);
  const observedAt = lifeEffectObservedAt(args.message, data);

  if (
    data?.deferred === true ||
    data?.saved === false ||
    data?.requiresConfirmation === true
  ) {
    return lifeEffectPreview(args.message, `${operation}.preview`);
  }

  if (args.result.success === false) {
    return lifeOpsFailedEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, requestId),
      operation,
      resource: { kind: "runtime.message", id: requestId },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt,
      failure: {
        code: lifeFailureCode(args.result),
        retryable: false,
        acceptance: "rejected",
      },
    });
  }

  const readOnlyOperation =
    operationHint === "review" ||
    operationHint === "overview" ||
    operationHint === "calendar" ||
    operationHint === "email" ||
    operationHint.startsWith("query_");
  if (
    (data?.noop === true || readOnlyOperation) &&
    lifeEffectRecord(data?.deleted) === null
  ) {
    const readGoal = lifeEffectRecord(data?.goal);
    const readGoalId = lifeEffectString(readGoal, "id");
    const resourceId = readGoalId ?? requestId;
    return lifeOpsNoopEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, resourceId),
      operation,
      resource: readGoalId
        ? {
            kind: "lifeops.goal",
            id: readGoalId,
            ...(lifeEffectString(readGoal, "updatedAt")
              ? { version: lifeEffectString(readGoal, "updatedAt") as string }
              : {}),
          }
        : { kind: "runtime.message", id: requestId },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt,
      reason:
        "The operation only read, evaluated, clarified, or intentionally left state unchanged.",
    });
  }

  const deleted = lifeEffectRecord(data?.deleted);
  const deletedId = lifeEffectString(deleted, "id");
  const deletedType = lifeEffectString(deleted, "kind");
  if (deletedId && (deletedType === "definition" || deletedType === "goal")) {
    const audit = await latestLifeAudit({
      runtime: args.runtime,
      ownerType: deletedType,
      ownerId: deletedId,
      eventTypes:
        deletedType === "definition"
          ? ["definition_deleted"]
          : ["goal_deleted"],
    });
    return lifeOpsAppliedEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, deletedId),
      operation:
        deletedType === "definition"
          ? "lifeops.definition.delete"
          : "lifeops.goal.delete",
      resource: {
        kind: `lifeops.${deletedType}`,
        id: deletedId,
        version: audit.id,
      },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: audit.createdAt,
      commit: {
        kind: "durable",
        id: audit.id,
        committedAt: audit.createdAt,
      },
    });
  }

  const definition =
    lifeEffectRecord(data?.definition) ??
    lifeEffectRecord(lifeEffectRecord(data?.updated)?.definition);
  const definitionId = lifeEffectString(definition, "id");
  const definitionUpdatedAt = lifeEffectString(definition, "updatedAt");
  if (definitionId && data?.deduplicated === true) {
    return lifeOpsNoopEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, definitionId),
      operation: "lifeops.definition.create",
      resource: {
        kind: "lifeops.definition",
        id: definitionId,
        ...(definitionUpdatedAt ? { version: definitionUpdatedAt } : {}),
      },
      artifacts: [],
      idempotency: { key: definitionId, replayed: true },
      observedAt,
      reason: "An equivalent active definition already exists.",
    });
  }
  if (definitionId && definitionUpdatedAt) {
    const audit = await latestLifeAudit({
      runtime: args.runtime,
      ownerType: "definition",
      ownerId: definitionId,
      eventTypes: ["definition_updated", "definition_created"],
    });
    return lifeOpsAppliedEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, definitionId),
      operation:
        audit.eventType === "definition_created"
          ? "lifeops.definition.create"
          : "lifeops.definition.update",
      resource: {
        kind: "lifeops.definition",
        id: definitionId,
        version: definitionUpdatedAt,
      },
      artifacts: [],
      idempotency:
        audit.eventType === "definition_created"
          ? { key: definitionId, replayed: false }
          : { key: null, replayed: false },
      observedAt: audit.createdAt,
      commit: {
        kind: "durable",
        id: audit.id,
        committedAt: audit.createdAt,
      },
    });
  }

  const goal = lifeEffectRecord(data?.goal);
  const goalId = lifeEffectString(goal, "id");
  const goalUpdatedAt = lifeEffectString(goal, "updatedAt");
  if (goalId && data?.deduplicated === true) {
    return lifeOpsNoopEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, goalId),
      operation: "lifeops.goal.create",
      resource: {
        kind: "lifeops.goal",
        id: goalId,
        ...(goalUpdatedAt ? { version: goalUpdatedAt } : {}),
      },
      artifacts: [],
      idempotency: { key: goalId, replayed: true },
      observedAt,
      reason: "An equivalent active goal already exists.",
    });
  }
  if (goalId && goalUpdatedAt) {
    const audit = await latestLifeAudit({
      runtime: args.runtime,
      ownerType: "goal",
      ownerId: goalId,
      eventTypes: ["goal_updated", "goal_created"],
    });
    return lifeOpsAppliedEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, goalId),
      operation:
        audit.eventType === "goal_created"
          ? "lifeops.goal.create"
          : "lifeops.goal.update",
      resource: {
        kind: "lifeops.goal",
        id: goalId,
        version: goalUpdatedAt,
      },
      artifacts: [],
      idempotency:
        audit.eventType === "goal_created"
          ? { key: goalId, replayed: false }
          : { key: null, replayed: false },
      observedAt: audit.createdAt,
      commit: {
        kind: "durable",
        id: audit.id,
        committedAt: audit.createdAt,
      },
    });
  }

  const occurrenceId = lifeEffectString(data, "id");
  const occurrenceUpdatedAt = lifeEffectString(data, "updatedAt");
  const occurrenceState = lifeEffectString(data, "state");
  const definitionIdForOccurrence = lifeEffectString(data, "definitionId");
  if (
    occurrenceId &&
    occurrenceUpdatedAt &&
    occurrenceState &&
    definitionIdForOccurrence
  ) {
    const audit = await latestLifeAudit({
      runtime: args.runtime,
      ownerType: "occurrence",
      ownerId: occurrenceId,
      eventTypes: [
        "occurrence_completed",
        "occurrence_skipped",
        "occurrence_snoozed",
      ],
    });
    const replayed = data?.effectReplayed === true;
    if (replayed) {
      return lifeOpsNoopEffect({
        receiptId: lifeEffectReceiptId(args.message, operation, occurrenceId),
        operation: `lifeops.occurrence.${occurrenceState}`,
        resource: {
          kind: "lifeops.occurrence",
          id: occurrenceId,
          version: occurrenceUpdatedAt,
        },
        artifacts: [
          {
            kind: "lifeops.definition",
            id: definitionIdForOccurrence,
          },
        ],
        idempotency: { key: occurrenceId, replayed: true },
        observedAt,
        reason: `The occurrence was already ${occurrenceState}.`,
      });
    }
    return lifeOpsAppliedEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, occurrenceId),
      operation: `lifeops.occurrence.${occurrenceState}`,
      resource: {
        kind: "lifeops.occurrence",
        id: occurrenceId,
        version: occurrenceUpdatedAt,
      },
      artifacts: [
        {
          kind: "lifeops.definition",
          id: definitionIdForOccurrence,
        },
      ],
      idempotency:
        occurrenceState === "completed" || occurrenceState === "skipped"
          ? { key: occurrenceId, replayed: false }
          : { key: null, replayed: false },
      observedAt: audit.createdAt,
      commit: {
        kind: "durable",
        id: audit.id,
        committedAt: audit.createdAt,
      },
    });
  }

  const preference = lifeEffectRecord(data?.preference);
  const effectivePreference = lifeEffectRecord(preference?.effective);
  const preferenceUpdatedAt = lifeEffectString(
    effectivePreference,
    "updatedAt",
  );
  if (preference && preferenceUpdatedAt) {
    const preferenceDefinitionId = lifeEffectString(preference, "definitionId");
    const resourceId = preferenceDefinitionId ?? "global";
    return lifeOpsAppliedEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, resourceId),
      operation: "lifeops.reminder_policy.update",
      resource: {
        kind: "lifeops.reminder_policy",
        id: resourceId,
        version: preferenceUpdatedAt,
      },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: preferenceUpdatedAt,
      commit: {
        kind: "durable",
        id: `lifeops.reminder_policy:${resourceId}:${preferenceUpdatedAt}`,
        committedAt: preferenceUpdatedAt,
      },
    });
  }

  const facts = lifeEffectRecord(data?.facts);
  const escalationRules = lifeEffectRecord(facts?.escalationRules);
  const escalationProvenance = lifeEffectRecord(escalationRules?.provenance);
  const escalationUpdatedAt = lifeEffectString(
    escalationProvenance,
    "recordedAt",
  );
  if (escalationUpdatedAt) {
    return lifeOpsAppliedEffect({
      receiptId: lifeEffectReceiptId(args.message, operation, "global"),
      operation: "lifeops.escalation_policy.update",
      resource: {
        kind: "lifeops.escalation_policy",
        id: "global",
        version: escalationUpdatedAt,
      },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: escalationUpdatedAt,
      commit: {
        kind: "durable",
        id: `lifeops.escalation_policy:global:${escalationUpdatedAt}`,
        committedAt: escalationUpdatedAt,
      },
    });
  }

  return lifeOpsNoopEffect({
    receiptId: lifeEffectReceiptId(args.message, operation, requestId),
    operation,
    resource: { kind: "runtime.message", id: requestId },
    artifacts: [],
    idempotency: {
      key:
        data?.deduplicated === true
          ? (lifeEffectString(data, "id") ?? requestId)
          : null,
      replayed: data?.deduplicated === true,
    },
    observedAt,
    reason:
      data?.deduplicated === true
        ? "The requested resource already exists."
        : "The operation only read, evaluated, clarified, or intentionally left state unchanged.",
  });
}

async function runLifeOperationHandlerInner(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
): Promise<ActionResult> {
  const ownerSurfaceActionName = ownerSurfaceActionNameFromOptions(options);
  // Defense-in-depth: validate() excludes owner-operation candidates on
  // foreign page-* scopes, and this handler keeps direct tool execution a
  // no-op if a stale or malformed plan still reaches it.
  if (await isForeignPageScope(runtime, message)) {
    return {
      success: false,
      text: "Owner life actions are unavailable from this page.",
      data: {
        actionName: ownerSurfaceActionName,
        reason: "foreign_page_scope",
      },
    };
  }

  const rawParams = (options as HandlerOptions | undefined)?.parameters as
    | LifeParams
    | undefined;
  const params = rawParams ?? ({} as LifeParams);
  const currentText = normalizeLifeInputText(
    extractPrimaryLifeInputText(messageText(message)),
  );
  const details = params.details;
  const stateDeferredDraft = latestDeferredLifeDraft(state);
  const cachedDeferredDraft = stateDeferredDraft
    ? null
    : await readDeferredLifeDraftCache(runtime, message);
  const deferredDraft = stateDeferredDraft ?? cachedDeferredDraft;
  const explicitCreateConfirmation =
    isExplicitLifeCreateConfirmation(currentText);
  const turnsSinceDraft =
    deferredDraft != null
      ? (countTurnsSinceLatestDeferredLifeDraft(state) ?? 0) + 1
      : undefined;
  // A bare yes skips the classifier; a yes that CARRIES content ("yes, save
  // that plan. draft first, citations after dinner…") must still be
  // classified, because confirm-mode reuses the parked draft verbatim and
  // would drop the newly named specifics (#16941 live, night-owl: the saved
  // plan kept the draft's slots and lost the after-dinner citations session).
  // The classifier abstaining never cancels an explicit yes, though — that
  // falls back to confirm instead of dropping consent.
  const deferredDraftFollowupMode = deferredDraft
    ? explicitCreateConfirmation &&
      isBareLifeCreateConfirmationMessage(currentText)
      ? "confirm"
      : ((await extractDeferredLifeDraftFollowupWithLlm({
          runtime,
          message,
          state,
          currentText,
          draft: deferredDraft,
        })) ?? (explicitCreateConfirmation ? "confirm" : null))
    : null;
  const draftExpiryReason = deferredLifeDraftExpiryReason({
    draft: deferredDraft,
    turnsSinceDraft,
  });
  if (draftExpiryReason && deferredDraftFollowupMode === "confirm") {
    await clearDeferredLifeDraftCache(runtime, message);
    const fallback =
      "That LifeOps draft expired. Please restate it and I'll preview it again.";
    return {
      success: false,
      text: await renderLifeActionReply({
        runtime,
        message,
        state,
        intent: currentText,
        scenario: "reply_only",
        fallback,
        context: {
          reason: "draft_expired",
        },
      }),
    };
  }
  if (deferredDraftFollowupMode === "cancel") {
    await clearDeferredLifeDraftCache(runtime, message);
    const fallback = "Okay, I won't save it yet.";
    return {
      success: true,
      text: await renderLifeActionReply({
        runtime,
        message,
        state,
        intent: currentText,
        scenario: "reply_only",
        fallback,
        context: {
          reason: "draft_cancelled",
          draft: deferredDraft
            ? {
                operation: deferredDraft.operation,
                title: deferredDraft.request.title,
              }
            : null,
        },
      }),
      data: {
        actionName: ownerSurfaceActionName,
        noop: true,
      },
    };
  }
  const explicitAction = normalizeExplicitLifeAction(params.action);
  // Retraction of an un-previewed save: the crisp-ask fast path persists with
  // no draft to cancel, and the planner cannot be trusted to translate
  // "actually don't save that one" into action=delete — observed live
  // (#16941, child-cancel-reask) it reviewed the row, replied "I won't save
  // it", and left the definition active. This runs before extraction so no
  // classifier verdict can strand the stale row; a same-message create
  // (retract + replace in one utterance) still runs after the deletion.
  if (deferredDraft === null && isLifeSaveRetraction(messageText(message))) {
    const recentSave = await readRecentLifeSaveCache(runtime, message);
    const retractionMessageId =
      message.id !== undefined && message.id !== null ? String(message.id) : "";
    if (
      recentSave !== null &&
      (recentSave.sourceMessageId === undefined ||
        recentSave.sourceMessageId !== retractionMessageId)
    ) {
      const retractionService = new LifeOpsService(runtime, {
        ownerEntityId: message.entityId,
      });
      const retracted = (await retractionService.listDefinitions()).find(
        (record) =>
          record.definition.id === recentSave.definitionId &&
          record.definition.status === "active",
      );
      await clearRecentLifeSaveCache(runtime, message);
      if (retracted) {
        await retractionService.deleteDefinition(retracted.definition.id);
        logger.info(
          `[LifeAction] retracted recent un-previewed save "${retracted.definition.title}" (${retracted.definition.id})`,
        );
        const plannerRequestedCreate =
          explicitAction !== null &&
          explicitAction !== "phone" &&
          explicitAction.operation === "create";
        if (!plannerRequestedCreate) {
          const fallback = `Okay — I removed "${retracted.definition.title}". Nothing is saved for it now.`;
          const text = await renderLifeActionReply({
            runtime,
            message,
            state,
            intent: currentText,
            scenario: "deleted_definition",
            fallback,
            context: {
              deleted: { title: retracted.definition.title },
              reason: "retracted_recent_save",
            },
          });
          return {
            success: true,
            text,
            userFacingText: text,
            verifiedUserFacing: true,
            data: {
              actionName: ownerSurfaceActionName,
              retractedRecentSave: true,
              deleted: {
                kind: "definition",
                id: retracted.definition.id,
                title: retracted.definition.title,
              },
            },
          };
        }
      }
    }
  }
  if (explicitAction === "phone") {
    return {
      success: false,
      text: "I need the phone number before I can save text reminders.",
      data: {
        actionName: ownerSurfaceActionName,
        missingField: "phone_number",
      },
    };
  }
  const explicitSubaction =
    typeof params.subaction === "string" &&
    Object.hasOwn(SUBACTIONS, params.subaction)
      ? (params.subaction as LifeOwnedOperation)
      : explicitAction?.operation;
  const deferredDraftReuseMode = resolveDeferredLifeDraftReuseMode({
    details,
    draft: deferredDraft,
    explicitConfirmation: explicitCreateConfirmation,
    explicitOperation: explicitSubaction,
    llmMode: deferredDraftFollowupMode,
    turnsSinceDraft,
  });
  const reuseDeferredDraft = deferredDraftReuseMode !== null;
  const intent = reuseDeferredDraft
    ? deferredDraftReuseMode === "confirm"
      ? normalizeLifeInputText(deferredDraft?.intent ?? "")
      : normalizeLifeInputText(params.intent?.trim() ?? currentText)
    : normalizeLifeInputText(params.intent?.trim() ?? currentText);
  if (!intent) {
    const fallback = "Tell me what you want me to do.";
    return {
      success: false,
      text: await renderLifeActionReply({
        runtime,
        message,
        state,
        intent: currentText,
        scenario: "reply_only",
        fallback,
        context: {
          reason: "missing_intent",
        },
      }),
    };
  }

  // Pre-routing: pick the subaction. When reusing a deferred draft we
  // inherit its operation. When the planner supplied an explicit subaction
  // we trust it. Otherwise dispatch through resolveActionArgs (the
  // shared LLM pre-routing substrate). The text extractor
  // stays available as a fallback for richer "missing field" diagnostics.
  const operationPlan: ResolvedLifeOperationPlan =
    reuseDeferredDraft && deferredDraft
      ? {
          confidence: 1,
          missing: [] as ExtractedLifeMissingField[],
          operation: "create",
          kind:
            deferredDraft.operation === "create_goal" ? "goal" : "definition",
          shouldAct: true,
        }
      : explicitAction
        ? {
            confidence: 1,
            missing: [],
            operation: explicitAction.operation,
            kind: explicitAction.kind,
            shouldAct: true,
          }
        : await routeLifeSubaction({
            runtime,
            message,
            state,
            options,
            intent,
            explicitSubaction,
          });
  const explicitKind: LifeKind | undefined =
    params.kind === "definition" || params.kind === "goal"
      ? params.kind
      : undefined;
  const forceGoalKind =
    looksLikeGoalTrackingFollowup(currentText) ||
    looksLikeGoalTrackingFollowup(intent);
  const resolvedKind: LifeKind | undefined = forceGoalKind
    ? "goal"
    : (operationPlan.kind ?? explicitKind);
  const forceCreateExecution = shouldForceLifeCreateExecution({
    intent,
    missing: operationPlan.missing,
    operation: operationPlan.operation,
    kind: resolvedKind,
    details,
    title: params.title,
  });
  if (!operationPlan.shouldAct && !forceCreateExecution) {
    const fallback = buildLifeClarificationFallback({
      missing: operationPlan.missing,
      operation: operationPlan.operation,
      kind: resolvedKind,
    });
    const text = await renderLifeActionReply({
      runtime,
      message,
      state,
      intent,
      scenario:
        operationPlan.operation === "create" && resolvedKind === "goal"
          ? "clarify_create_goal"
          : "clarify_create_definition",
      fallback,
      context: {
        missing: operationPlan.missing,
        operation: operationPlan.operation,
      },
    });
    return {
      success: true,
      text,
      userFacingText: text,
      values: {
        success: true,
        noop: true,
        awaitingUserInput: true,
        suggestedOperation: operationPlan.operation,
      },
      data: {
        actionName: ownerSurfaceActionName,
        noop: true,
        awaitingUserInput: true,
        suggestedOperation: operationPlan.operation,
      },
    };
  }
  const operation: LifeOwnedOperation | null = forceCreateExecution
    ? "create"
    : isLifeOwnedOperation(operationPlan.operation)
      ? operationPlan.operation
      : null;
  const queryOperation = forceCreateExecution
    ? null
    : !isLifeOwnedOperation(operationPlan.operation)
      ? operationPlan.operation
      : null;
  const service = new LifeOpsService(runtime, {
    ownerEntityId: message.entityId,
  });
  if (
    queryOperation === "query_calendar_today" ||
    queryOperation === "query_calendar_next" ||
    queryOperation === "query_email"
  ) {
    // Read-only connected-account queries: gate on the real Google capability
    // snapshot (lifeops/access.ts) and serve them; refuse only when calendar
    // or Gmail access is actually missing.
    return runLifeConnectedQuery({
      runtime,
      message,
      state,
      intent,
      service,
      queryOperation,
      actionName: ownerSurfaceActionName,
    });
  }
  if (queryOperation === "query_overview") {
    const overview = await service.getOverview();
    const userQuery = messageText(message) || intent || "overview";
    const fallback = formatOverviewForQuery(overview, userQuery);
    return {
      success: true,
      text: await renderLifeActionReply({
        runtime,
        message,
        state,
        intent: userQuery,
        scenario: "overview",
        fallback,
        context: {
          summary: overview.owner.summary,
          occurrenceTitles: overview.owner.occurrences
            .slice(0, 6)
            .map((occurrence) => occurrence.title),
          goalTitles: overview.owner.goals
            .slice(0, 3)
            .map((goal) => goal.title),
        },
      }),
      data: toActionData(overview),
    };
  }
  // Internal handler dispatch key (definition vs goal split lives here).
  // For create/update/delete, infer kind from explicit param, plan, draft, or
  // intent; for occurrence-level verbs the kind is irrelevant.
  const kind: LifeKind =
    resolvedKind ??
    (operation === "create" || operation === "update" || operation === "delete"
      ? inferLifeKindFromIntent(intent)
      : "definition");
  const internalOp: InternalLifeOp | null = operation
    ? toInternalLifeOp(operation, kind)
    : null;
  if (!operation) {
    const fallback = "Tell me what LifeOps action you want me to take.";
    return {
      success: true,
      text: await renderLifeActionReply({
        runtime,
        message,
        state,
        intent,
        scenario: "reply_only",
        fallback,
        context: {
          reason: "missing_operation_after_extraction",
        },
      }),
      data: {
        actionName: ownerSurfaceActionName,
        noop: true,
      },
    };
  }
  const domain = detailString(details, "domain") as LifeOpsDomain | undefined;
  const ownership = requestedOwnership(domain);
  // Params extracted by the routing pass (resolveActionArgs) fill gaps the
  // planner left open — snooze minutes/preset and the target especially.
  const routedParams = operationPlan.params;
  const targetName =
    params.target ??
    params.title ??
    routedParams?.target ??
    routedParams?.title;
  // Planner-asserted `confirmed` is only real consent when the owner has
  // actually seen a preview: either the current owner text is an explicit
  // yes, or a draft previewed on an EARLIER message is still pending.
  // Observed live (#16941, child-morning-routine): after previewing a daily
  // routine, the planner immediately re-called create with confirmed:true in
  // the same turn — saving a routine the child never approved — then told the
  // child nothing was saved, and the real confirm turn duplicated the row.
  const plannerAssertedConfirmed =
    params.confirmed === true || detailBoolean(details, "confirmed") === true;
  const currentMessageId =
    message.id !== undefined && message.id !== null ? String(message.id) : "";
  const priorTurnDraftPending =
    deferredDraft != null &&
    (deferredDraft.sourceMessageId === undefined ||
      currentMessageId === "" ||
      deferredDraft.sourceMessageId !== currentMessageId);
  const createConfirmed =
    deferredDraftReuseMode === "confirm" ||
    explicitCreateConfirmation ||
    (plannerAssertedConfirmed && priorTurnDraftPending);

  try {
    const createDefinition = async () => {
      const deferredDefinitionDraft =
        reuseDeferredDraft && deferredDraft?.operation === "create_definition"
          ? deferredDraft
          : null;
      const editingDeferredDefinitionDraft =
        deferredDraftReuseMode === "edit" &&
        deferredDefinitionDraft?.operation === "create_definition";
      const explicitCadenceDetail = normalizeCadenceDetail(
        detailObject(details, "cadence"),
      );
      const hasCompleteNativeDefinitionCreatePlan = Boolean(
        params.title && explicitCadenceDetail && detailString(details, "kind"),
      );
      const fallbackTitle = deferredDefinitionDraft?.request.title ?? null;
      let title: string | null = editingDeferredDefinitionDraft
        ? (params.title ?? fallbackTitle)
        : (fallbackTitle ?? params.title ?? null);
      const fallbackCadence = deferredDefinitionDraft?.request.cadence;
      let cadence: LifeOpsCadence | undefined = editingDeferredDefinitionDraft
        ? (explicitCadenceDetail ?? fallbackCadence ?? undefined)
        : (fallbackCadence ?? explicitCadenceDetail ?? undefined);
      let windowPolicy:
        | CreateLifeOpsDefinitionRequest["windowPolicy"]
        | undefined = editingDeferredDefinitionDraft
        ? // detailObject returns Record<string,unknown>; cast to the policy
          // type at this validated boundary.
          ((detailObject(details, "windowPolicy") as
            | CreateLifeOpsDefinitionRequest["windowPolicy"]
            | undefined) ?? deferredDefinitionDraft.request.windowPolicy)
        : (deferredDefinitionDraft?.request.windowPolicy ??
          (detailObject(details, "windowPolicy") as
            | CreateLifeOpsDefinitionRequest["windowPolicy"]
            | undefined));
      const explicitPriority = detailNumber(details, "priority");
      const explicitDescription = detailString(details, "description");
      const explicitMetadata = detailObject(details, "metadata") as
        | Record<string, unknown>
        | undefined;

      // Owner's stored timezone fact (travel-aware), used as the fallback zone
      // for a conversational create when no zone was stated out loud and no
      // more-specific candidate (explicit detail / planner / deferred draft /
      // window policy) is present. Without this, "remind me tomorrow at 9am"
      // resolves 9am against the HOST clock (`resolveDefaultTimeZone()` = UTC
      // on shared-server / TZ=UTC topologies) instead of the owner's wall
      // clock (#13509). Read once here; the store call falls back to the host
      // zone itself when no owner fact is stored, so `ownerFactTimeZone` is
      // always a concrete zone (never fabricated).
      const ownerFactTimeZone = await resolveOwnerTimeZone(runtime, new Date());

      // Track whether cadence/title came from explicit high-confidence
      // sources so the planner only fills genuine gaps.
      const hadExplicitCadence = Boolean(
        (editingDeferredDefinitionDraft
          ? (explicitCadenceDetail ?? deferredDefinitionDraft.request.cadence)
          : deferredDefinitionDraft?.request.cadence) ?? explicitCadenceDetail,
      );
      const hadExplicitTitle = Boolean(
        (editingDeferredDefinitionDraft
          ? params.title
          : deferredDefinitionDraft?.request.title) ?? params.title,
      );

      // Parameter enhancement fills gaps when structured planner input is partial.
      // Skip when options.parameters already contain the complete
      // definition-create shape, or when reusing a confirmed deferred draft.
      let llmPlan: Awaited<
        ReturnType<typeof extractTaskCreatePlanWithLlm>
      > | null = null;
      let llmDescription: string | undefined;
      let llmPriority: number | undefined;
      let llmRequestKind: NativeAppleReminderLikeKind | null = null;
      if (
        (!deferredDefinitionDraft || editingDeferredDefinitionDraft) &&
        !hasCompleteNativeDefinitionCreatePlan
      ) {
        llmPlan = await extractTaskCreatePlanWithLlm({
          runtime,
          intent,
          state: state ?? undefined,
          message: message,
          timeZone:
            normalizeLifeTimeZoneToken(
              detailString(details, "timeZone") ??
                deferredDefinitionDraft?.request.timezone ??
                windowPolicy?.timezone,
            ) ?? undefined,
        });
        const shouldHonorPlannerResponse =
          llmPlan.mode === "respond" &&
          Boolean(llmPlan.response) &&
          !editingDeferredDefinitionDraft &&
          !params.title &&
          !explicitCadenceDetail &&
          !detailString(details, "description") &&
          !detailString(details, "goalId") &&
          !detailString(details, "goalTitle") &&
          !detailString(details, "kind");
        if (shouldHonorPlannerResponse && llmPlan.response) {
          const text = llmPlan.response;
          return {
            success: true as const,
            text,
            userFacingText: text,
            values: {
              success: true,
              noop: true,
              awaitingUserInput: true,
              suggestedOperation: "create",
            },
            data: {
              actionName: ownerSurfaceActionName,
              noop: true,
              awaitingUserInput: true,
              suggestedOperation: "create",
            },
          };
        }
        if (llmPlan) {
          llmRequestKind = llmPlan.requestKind;
          if (
            !hadExplicitTitle &&
            shouldAdoptPlannerTitle({
              currentTitle: title,
              plannerTitle: llmPlan.title,
            })
          ) {
            title = llmPlan.title;
          }
          if (
            (editingDeferredDefinitionDraft || !hadExplicitCadence) &&
            llmPlan.cadenceKind
          ) {
            const llmCadenceTimeZone =
              normalizeLifeTimeZoneToken(
                detailString(details, "timeZone") ??
                  llmPlan.timeZone ??
                  deferredDefinitionDraft?.request.timezone ??
                  windowPolicy?.timezone,
              ) ?? ownerFactTimeZone;
            const llmCadence = buildCadenceFromLlmParams(llmPlan, {
              intent,
              timeZone: llmCadenceTimeZone ?? undefined,
            });
            if (
              llmCadence &&
              shouldAdoptPlannerCadence({
                currentCadence: cadence,
                plannerCadence: llmCadence.cadence,
              })
            ) {
              cadence = llmCadence.cadence;
              windowPolicy = llmCadence.windowPolicy ?? windowPolicy;
            }
          }
          if (!explicitDescription && llmPlan.description) {
            llmDescription = llmPlan.description;
          }
          if (explicitPriority === undefined && llmPlan.priority) {
            llmPriority = llmPlan.priority;
          }
        }
      }
      const resolvedTimeZone =
        normalizeLifeTimeZoneToken(
          detailString(details, "timeZone") ??
            llmPlan?.timeZone ??
            deferredDefinitionDraft?.request.timezone ??
            windowPolicy?.timezone,
        ) ?? ownerFactTimeZone;
      const timedRequestKind = llmRequestKind;
      const nativeAppleMetadata =
        timedRequestKind && cadence?.kind === "once"
          ? buildNativeAppleReminderMetadata({
              kind: timedRequestKind,
              source: "llm",
            })
          : undefined;
      const definitionMetadata = editingDeferredDefinitionDraft
        ? mergeMetadataRecords(
            deferredDefinitionDraft.request.metadata,
            mergeMetadataRecords(explicitMetadata, nativeAppleMetadata),
          )
        : (deferredDefinitionDraft?.request.metadata ??
          mergeMetadataRecords(explicitMetadata, nativeAppleMetadata));

      if (!title) {
        const fallback = "What should I call it?";
        const text = await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "clarify_create_definition",
          fallback,
          context: {
            missing: ["title"],
            operation: "create_definition",
          },
        });
        return {
          success: false as const,
          text,
          userFacingText: text,
          // Asking the owner to fill in a missing field — selection +
          // execution were both correct, terminal state is "needs human
          // input". Flag so the native planner chain breaks and the spy
          // scores this as completed.
          values: {
            success: false,
            error: "MISSING_DEFINITION_FIELD",
            missingField: "title",
            requiresConfirmation: true,
            awaitingUserInput: true,
          },
          data: {
            actionName: ownerSurfaceActionName,
            missingField: "title",
            requiresConfirmation: true,
            awaitingUserInput: true,
          },
        };
      }
      if (!cadence) {
        const fallback = "When should it happen?";
        const text = await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "clarify_create_definition",
          fallback,
          context: {
            missing: ["schedule"],
            operation: "create_definition",
          },
        });
        return {
          success: false as const,
          text,
          userFacingText: text,
          values: {
            success: false,
            error: "MISSING_DEFINITION_FIELD",
            missingField: "schedule",
            requiresConfirmation: true,
            awaitingUserInput: true,
          },
          data: {
            actionName: ownerSurfaceActionName,
            missingField: "schedule",
            requiresConfirmation: true,
            awaitingUserInput: true,
          },
        };
      }
      const kind =
        (editingDeferredDefinitionDraft
          ? (detailString(details, "kind") as
              | CreateLifeOpsDefinitionRequest["kind"]
              | undefined)
          : deferredDefinitionDraft?.request.kind) ??
        (detailString(details, "kind") as
          | CreateLifeOpsDefinitionRequest["kind"]
          | undefined) ??
        "habit";
      const leadShaped = applyLeadUpReminderShape({
        cadence,
        plan:
          (detailObject(details, "reminderPlan") as
            | CreateLifeOpsDefinitionRequest["reminderPlan"]
            | undefined) ??
          deferredDefinitionDraft?.request.reminderPlan ??
          buildDefaultReminderPlan(`${title} reminder`),
        ownerText: messageText(message),
        title,
        milestones: resolveMilestoneLabels({
          details,
          intent,
          ownerText: messageText(message),
          multiStep: llmPlan?.multiStep === true,
        }),
      });
      const definitionDraft: DeferredLifeDefinitionDraft = {
        intent,
        operation: "create_definition",
        createdAt: editingDeferredDefinitionDraft
          ? Date.now()
          : (deferredDefinitionDraft?.createdAt ?? Date.now()),
        // Preserve the ORIGINAL previewing turn's id on reuse — a same-turn
        // re-preview must not launder the draft into "prior-turn" consent.
        sourceMessageId:
          deferredDefinitionDraft?.sourceMessageId ??
          (currentMessageId !== "" ? currentMessageId : undefined),
        request: {
          cadence: leadShaped.cadence,
          description:
            explicitDescription ??
            llmDescription ??
            (editingDeferredDefinitionDraft
              ? deferredDefinitionDraft.request.description
              : undefined),
          goalRef:
            detailString(details, "goalId") ??
            detailString(details, "goalTitle") ??
            deferredDefinitionDraft?.request.goalRef ??
            undefined,
          kind,
          priority:
            explicitPriority ??
            llmPriority ??
            deferredDefinitionDraft?.request.priority,
          progressionRule:
            (detailObject(
              details,
              "progressionRule",
            ) as CreateLifeOpsDefinitionRequest["progressionRule"]) ??
            deferredDefinitionDraft?.request.progressionRule,
          reminderPlan: leadShaped.plan,
          timezone:
            normalizeLifeTimeZoneToken(llmPlan?.timeZone) ??
            normalizeLifeTimeZoneToken(
              resolvedTimeZone ?? deferredDefinitionDraft?.request.timezone,
            ) ??
            resolvedTimeZone ??
            deferredDefinitionDraft?.request.timezone,
          title,
          metadata: definitionMetadata,
          windowPolicy,
          // detailObject returns Record<string,unknown>; cast at validated boundary.
          websiteAccess:
            (detailObject(details, "websiteAccess") as
              | CreateLifeOpsDefinitionRequest["websiteAccess"]
              | undefined) ?? deferredDefinitionDraft?.request.websiteAccess,
        },
      };
      if (
        shouldRequireLifeCreateConfirmation({
          confirmed: createConfirmed,
          messageSource:
            typeof message.content.source === "string"
              ? message.content.source
              : undefined,
          requestKind: timedRequestKind,
          cadence: definitionDraft.request.cadence,
          multiStep: llmPlan?.multiStep === true,
        })
      ) {
        const draftLeadSteps = (
          definitionDraft.request.reminderPlan?.steps ?? []
        )
          .map((step) => ({
            label: step.label,
            minutesBeforeDue: reminderStepMinutesBeforeDue(
              definitionDraft.request.cadence,
              step.offsetMinutes,
            ),
          }))
          .filter((step) => step.minutesBeforeDue >= 60);
        const draftLeadPhrase =
          draftLeadSteps.length > 0
            ? ` It includes early nudges: ${draftLeadSteps
                .map(
                  (step) =>
                    `"${step.label}" ${formatLeadOffsetPhrase(step.minutesBeforeDue)} before`,
                )
                .join(", ")}.`
            : "";
        const fallback = `I can save this as a ${definitionDraft.request.kind} named "${definitionDraft.request.title}" that happens ${summarizeCadence(definitionDraft.request.cadence)}.${draftLeadPhrase} Confirm and I'll save it, or tell me what to change.`;
        const previewText = await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "preview_definition",
          fallback,
          context: {
            draft: definitionDraft.request,
            requestKind: timedRequestKind,
          },
        });
        // A preview is NOT a save: nothing is persisted here, only a draft is
        // parked for the confirm turn. Reporting success:true made the model
        // render "I've set it" for a recurring create that never persisted
        // (task_611a9f0b — a no-fabricate violation). success:false +
        // requiresConfirmation makes the deferred state honest; the draft still
        // survives on `data.lifeDraft` for the next-turn confirmation.
        await writeDeferredLifeDraftCache(runtime, message, definitionDraft);
        return {
          success: false as const,
          text: previewText,
          userFacingText: previewText,
          verifiedUserFacing: true,
          data: {
            actionName: ownerSurfaceActionName,
            deferred: true,
            saved: false,
            requiresConfirmation: true,
            lifeDraft: definitionDraft,
            preview: {
              cadence: definitionDraft.request.cadence,
              kind: definitionDraft.request.kind,
              title: definitionDraft.request.title,
            },
          },
        };
      }
      const resolvedGoal = definitionDraft.request.goalRef
        ? await resolveGoal(service, definitionDraft.request.goalRef, domain)
        : null;

      // Content-level duplicate guard, mirroring the scheduled-task one: a
      // confirm turn that re-describes an already-saved item mints a fresh
      // create (observed live, #16941: "yes lock it in! and can it bug me
      // before friday too" after the plan had saved stacked a second
      // identical "Book report…" definition). An ACTIVE definition with the
      // same normalized title and structurally identical cadence IS the same
      // item — report it as already saved instead of stacking a twin.
      const duplicateOf = (await service.listDefinitions()).find(
        (record) =>
          record.definition.status === "active" &&
          normalizeLifeInputText(record.definition.title).toLowerCase() ===
            normalizeLifeInputText(
              definitionDraft.request.title,
            ).toLowerCase() &&
          stableCadenceKey(record.definition.cadence) ===
            stableCadenceKey(definitionDraft.request.cadence),
      );
      if (duplicateOf) {
        await clearDeferredLifeDraftCache(runtime, message);
        const alreadyText = `"${duplicateOf.definition.title}" is already saved as ${summarizeCadence(duplicateOf.definition.cadence)} — nothing new was created.`;
        return {
          success: true as const,
          text: alreadyText,
          userFacingText: alreadyText,
          verifiedUserFacing: true,
          data: {
            actionName: ownerSurfaceActionName,
            deduplicated: true,
            definition: duplicateOf.definition,
          },
        };
      }

      const created = await service.createDefinition({
        ownership,
        kind: definitionDraft.request.kind,
        title: definitionDraft.request.title,
        description: definitionDraft.request.description,
        originalIntent: definitionDraft.intent || definitionDraft.request.title,
        cadence: definitionDraft.request.cadence,
        timezone:
          normalizeLifeTimeZoneToken(definitionDraft.request.timezone) ??
          definitionDraft.request.timezone,
        priority: definitionDraft.request.priority,
        windowPolicy: definitionDraft.request.windowPolicy,
        progressionRule: definitionDraft.request.progressionRule,
        reminderPlan: definitionDraft.request.reminderPlan,
        metadata: definitionDraft.request.metadata,
        websiteAccess: definitionDraft.request.websiteAccess,
        goalId: resolvedGoal?.goal.id ?? null,
        source: "chat",
      });
      await clearDeferredLifeDraftCache(runtime, message);
      // The un-previewed fast path leaves no draft to cancel, so park an undo
      // handle: a next-turn retraction deletes this row deterministically.
      await writeRecentLifeSaveCache(runtime, message, {
        definitionId: created.definition.id,
        title: created.definition.title,
        createdAt: Date.now(),
        ...(currentMessageId !== ""
          ? { sourceMessageId: currentMessageId }
          : {}),
      });
      const savedLeadSteps = (created.reminderPlan?.steps ?? [])
        .map((step) => ({
          label: step.label,
          minutesBeforeDue: reminderStepMinutesBeforeDue(
            created.definition.cadence,
            step.offsetMinutes,
          ),
        }))
        .filter((step) => step.minutesBeforeDue >= 60);
      const leadPhrase =
        savedLeadSteps.length === 1
          ? ` with an early nudge ${formatLeadOffsetPhrase(savedLeadSteps[0].minutesBeforeDue)} before`
          : savedLeadSteps.length > 1
            ? ` with early nudges ${savedLeadSteps
                .map(
                  (step) =>
                    `"${step.label}" ${formatLeadOffsetPhrase(step.minutesBeforeDue)} before`,
                )
                .join(", ")}`
            : "";
      const fallback = `Saved "${created.definition.title}" as ${summarizeCadence(created.definition.cadence)}${leadPhrase}.`;
      const savedText = await renderLifeActionReply({
        runtime,
        message,
        state,
        intent,
        scenario: "saved_definition",
        fallback,
        context: {
          created: {
            title: created.definition.title,
            cadence: created.definition.cadence,
            ...(savedLeadSteps.length > 0
              ? {
                  earlyNudges: savedLeadSteps.map(
                    (step) =>
                      `${step.label} ${formatLeadOffsetPhrase(step.minutesBeforeDue)} before`,
                  ),
                }
              : {}),
          },
          requestKind: timedRequestKind,
        },
      });
      // verifiedUserFacing mirrors the preview branch: a completed persist is
      // exactly the state the evaluator must not paraphrase — observed live
      // (#16941): the synthesized reply told the owner "nothing is saved yet"
      // after this branch had already persisted the definition.
      return {
        success: true as const,
        text: savedText,
        userFacingText: savedText,
        verifiedUserFacing: true,
        data: toActionData(created),
      };
    };

    // ── Mutations ───────────────────────────────────

    if (internalOp === "create_definition") {
      return await createDefinition();
    }

    if (internalOp === "create_goal") {
      const goalCreateConfirmed =
        createConfirmed &&
        isExplicitLifeCreateConfirmation(messageText(message));
      const deferredGoalDraft =
        reuseDeferredDraft && deferredDraft?.operation === "create_goal"
          ? deferredDraft
          : null;
      const editingDeferredGoalDraft =
        deferredDraftReuseMode === "edit" &&
        deferredGoalDraft?.operation === "create_goal";
      const explicitDescription = detailString(details, "description");
      const explicitCadence = normalizeCadenceDetail(
        detailObject(details, "cadence"),
      ) as CreateLifeOpsGoalRequest["cadence"];
      const explicitSuccessCriteria = detailObject(
        details,
        "successCriteria",
      ) as CreateLifeOpsGoalRequest["successCriteria"] | undefined;
      const explicitSupportStrategy = detailObject(
        details,
        "supportStrategy",
      ) as CreateLifeOpsGoalRequest["supportStrategy"] | undefined;
      const explicitMetadata = detailObject(details, "metadata") as
        | CreateLifeOpsGoalRequest["metadata"]
        | undefined;
      let title: string | null = editingDeferredGoalDraft
        ? (params.title ?? deferredGoalDraft.request.title)
        : (deferredGoalDraft?.request.title ?? params.title ?? null);
      let description: string | undefined = editingDeferredGoalDraft
        ? (explicitDescription ?? deferredGoalDraft.request.description)
        : (deferredGoalDraft?.request.description ?? explicitDescription);
      let cadence = editingDeferredGoalDraft
        ? (explicitCadence ?? deferredGoalDraft.request.cadence)
        : (deferredGoalDraft?.request.cadence ?? explicitCadence);
      let successCriteria = editingDeferredGoalDraft
        ? (explicitSuccessCriteria ?? deferredGoalDraft.request.successCriteria)
        : (deferredGoalDraft?.request.successCriteria ??
          explicitSuccessCriteria);
      let supportStrategy = editingDeferredGoalDraft
        ? (explicitSupportStrategy ?? deferredGoalDraft.request.supportStrategy)
        : (deferredGoalDraft?.request.supportStrategy ??
          explicitSupportStrategy);
      let goalMetadata: CreateLifeOpsGoalRequest["metadata"] | undefined =
        editingDeferredGoalDraft
          ? (explicitMetadata ?? deferredGoalDraft.request.metadata)
          : (deferredGoalDraft?.request.metadata ?? explicitMetadata);
      let evaluationSummary: string | null = null;

      const hasExplicitGroundedGoal =
        Boolean(title) && Boolean(successCriteria) && Boolean(supportStrategy);

      if (hasExplicitGroundedGoal) {
        const successSummary =
          successCriteria &&
          typeof successCriteria.summary === "string" &&
          successCriteria.summary.trim().length > 0
            ? successCriteria.summary.trim()
            : null;
        goalMetadata = mergeGoalMetadataWithGrounding({
          metadata: {
            ...goalMetadata,
            source: "chat",
            originalIntent: intent,
          },
          nowIso: new Date().toISOString(),
          plan: {
            cadence,
            confidence: null,
            evaluationSummary:
              successSummary ?? description ?? "Goal has explicit criteria.",
            groundingState: "grounded",
            missingCriticalFields: [],
            successCriteria,
            targetDomain: null,
          },
        });
      }

      if (
        (!deferredGoalDraft || editingDeferredGoalDraft) &&
        !hasExplicitGroundedGoal
      ) {
        const groundingIntent = buildGoalGroundingIntent(intent, details);
        const llmPlan = await extractGoalCreatePlanWithLlm({
          runtime,
          intent: groundingIntent,
          state: state ?? undefined,
          message: message,
        });
        if (!title && llmPlan.title) {
          title = llmPlan.title;
        }
        if (!description && llmPlan.description) {
          description = llmPlan.description;
        }
        if (!cadence && llmPlan.cadence) {
          cadence = llmPlan.cadence;
        }
        if (!successCriteria && llmPlan.successCriteria) {
          successCriteria = llmPlan.successCriteria;
        }
        if (!supportStrategy && llmPlan.supportStrategy) {
          supportStrategy = llmPlan.supportStrategy;
        }
        evaluationSummary = llmPlan.evaluationSummary;
        if (
          llmPlan.groundingState === "grounded" &&
          llmPlan.successCriteria &&
          title
        ) {
          goalMetadata = mergeGoalMetadataWithGrounding({
            metadata: {
              ...goalMetadata,
              source: "chat",
              originalIntent: intent,
            },
            nowIso: new Date().toISOString(),
            plan: llmPlan,
          });
        }
        if (
          llmPlan.groundingState !== "grounded" ||
          !title ||
          !successCriteria ||
          !supportStrategy
        ) {
          const text =
            llmPlan.response ??
            "What would count as success for that goal, and over what time window?";
          // A clarification request is a successful outcome from the
          // agent's point of view — the agent chose to ask instead of
          // invent an ungrounded goal. Callers rely on `success: true +
          // data.noop: true` to distinguish a deliberate clarify from a
          // handler error.
          return {
            success: true,
            text,
            userFacingText: text,
            values: {
              success: true,
              error: "NOOP_GOAL_UNGROUNDED",
              noop: true,
              suggestedOperation: "create_goal",
            },
            data: {
              actionName: ownerSurfaceActionName,
              noop: true,
              error: "NOOP_GOAL_UNGROUNDED",
              suggestedOperation: "create_goal",
            },
          };
        }
      }

      if (!title)
        return {
          success: false,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "clarify_create_goal",
            fallback: "What are you trying to achieve?",
            context: {
              missing: ["title"],
              operation: "create_goal",
            },
          }),
        };
      const goalDraft: DeferredLifeGoalDraft = deferredGoalDraft ?? {
        intent,
        operation: "create_goal",
        createdAt: Date.now(),
        sourceMessageId: currentMessageId !== "" ? currentMessageId : undefined,
        request: {
          cadence,
          description,
          metadata: goalMetadata,
          successCriteria,
          supportStrategy,
          title,
        },
      };
      const experienceLoop = await service.buildGoalExperienceLoop({
        title: goalDraft.request.title,
        description: goalDraft.request.description,
        successCriteria:
          (goalDraft.request.successCriteria as
            | Record<string, unknown>
            | undefined) ?? null,
      });
      if (
        shouldRequireLifeCreateConfirmation({
          confirmed: goalCreateConfirmed,
          messageSource:
            typeof message.content.source === "string"
              ? message.content.source
              : undefined,
        })
      ) {
        if (
          !goalSuccessCriteriaLooksConcrete(goalDraft.request) ||
          (!deferredGoalDraft &&
            !ownerTextHasConcreteGoalCriteria(messageText(message)))
        ) {
          const text = buildConcreteGoalSuccessQuestion(
            goalDraft.request.title,
          );
          return {
            success: false,
            text,
            userFacingText: text,
            data: {
              actionName: ownerSurfaceActionName,
              deferred: true,
              saved: false,
              requiresConfirmation: true,
              lifeDraft: goalDraft,
              experienceLoop,
              preview: {
                title: goalDraft.request.title,
              },
            },
          };
        }
        const fallbackParts = [
          evaluationSummary
            ? `I can save "${goalDraft.request.title}" as a goal. Success looks like this: ${evaluationSummary} Confirm and I'll save it, or tell me what to change.`
            : `I can save this goal as "${goalDraft.request.title}". Confirm and I'll save it, or tell me what to change.`,
        ];
        const supportSummary = summarizeGoalSupportStrategyForPreview(
          goalDraft.request.supportStrategy,
        );
        if (supportSummary) {
          fallbackParts.push(supportSummary);
        }
        const detailSummary = summarizeGoalInputDetailsForPreview(
          currentText,
          fallbackParts.join(" "),
        );
        if (detailSummary) {
          fallbackParts.push(detailSummary);
        }
        const experienceSummary =
          formatGoalExperienceLoopSummary(experienceLoop);
        if (experienceSummary) {
          fallbackParts.push(experienceSummary);
        }
        const previewText = fallbackParts.join(" ");
        // Preview only — the goal is not persisted until the confirm turn.
        // success:false keeps the "not saved yet" state honest (no-fabricate,
        // task_611a9f0b); `verifiedUserFacing` prevents a later evaluator pass
        // from adding a second generic question after the concrete confirmation
        // prompt. The draft survives on `data.lifeDraft` for confirm.
        await writeDeferredLifeDraftCache(runtime, message, goalDraft);
        return {
          success: false,
          text: previewText,
          userFacingText: previewText,
          verifiedUserFacing: true,
          values: {
            success: false,
            saved: false,
            requiresConfirmation: true,
          },
          data: {
            actionName: ownerSurfaceActionName,
            deferred: true,
            saved: false,
            requiresConfirmation: true,
            lifeDraft: goalDraft,
            experienceLoop,
            preview: {
              title: goalDraft.request.title,
            },
          },
        };
      }
      const created = await service.createGoal({
        ownership,
        title: goalDraft.request.title,
        description: goalDraft.request.description,
        cadence: goalDraft.request.cadence,
        supportStrategy: goalDraft.request.supportStrategy,
        successCriteria: goalDraft.request.successCriteria,
        metadata: {
          ...goalDraft.request.metadata,
          source: "chat",
          originalIntent: goalDraft.intent || goalDraft.request.title,
        },
      });
      await clearDeferredLifeDraftCache(runtime, message);
      const createAudit = await latestLifeAudit({
        runtime,
        ownerType: "goal",
        ownerId: created.goal.id,
        eventTypes: ["goal_created"],
      });
      if (createAudit.decision.dedup === true) {
        const text = `"${created.goal.title}" is already saved as a goal — nothing new was created.`;
        return {
          success: true,
          text,
          userFacingText: text,
          verifiedUserFacing: true,
          data: toActionData({
            ...created,
            deduplicated: true,
          }),
        };
      }
      const createdExperienceLoop = await service.buildGoalExperienceLoop({
        goalId: created.goal.id,
        title: created.goal.title,
        description: created.goal.description,
        successCriteria:
          (created.goal.successCriteria as
            | Record<string, unknown>
            | undefined) ?? null,
      });
      const experienceSummary = formatGoalExperienceLoopSummary(
        createdExperienceLoop,
      );
      const text = experienceSummary
        ? `${buildSavedGoalReply(created.goal)} ${experienceSummary}`
        : buildSavedGoalReply(created.goal);
      return {
        success: true,
        text,
        userFacingText: text,
        data: toActionData({
          ...created,
          experienceLoop: createdExperienceLoop,
        }),
      };
    }

    if (internalOp === "update_definition") {
      const mutationScope = definitionMutationScope({
        runtime,
        message,
        domain,
      });
      const requestId = lifeEffectRequestId(message);
      const priorMutation = await service.repository.getDefinitionMutation({
        scope: mutationScope,
        requestId,
        operation: "update_definition",
      });
      if (priorMutation?.status === "completed") {
        const updated = await service.getDefinition(priorMutation.definitionId);
        const fallback = `Updated "${updated.definition.title}".`;
        const text = await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "updated_definition",
          fallback,
          context: {
            previousTitle: updated.definition.title,
            updated: { title: updated.definition.title },
          },
        });
        return {
          success: true,
          text,
          userFacingText: text,
          verifiedUserFacing: true,
          data: toActionData({
            ...updated,
            deduplicated: true,
            mutationObservedAt: priorMutation.observedAt,
          }),
        };
      }
      if (priorMutation) {
        return {
          success: false,
          text:
            priorMutation.status === "pending"
              ? "That update is already in progress. I will not apply it twice."
              : "That update previously failed and was not retried automatically.",
        };
      }
      const requestedTime = detailString(details, "time");
      const requestedTimeZone = normalizeLifeTimeZoneToken(
        detailString(details, "timezone"),
      );
      const { match: target, ambiguousCandidates } =
        await resolveDefinitionForMutation(
          service,
          targetName,
          messageText(message) || intent,
          domain,
        );
      if (!target) {
        return {
          success: false,
          text:
            ambiguousCandidates.length > 0
              ? `Please name the exact item to update:\n${ambiguousCandidates.map((title) => `  - ${title}`).join("\n")}`
              : "I could not ground that update in an item you explicitly named.",
        };
      }
      if (
        requestedTime !== undefined &&
        requestedTimeZone === null &&
        /\b(?:landing|arrival|outbound|departure|flight|trip|travel)\b/i.test(
          target.definition.title,
        )
      ) {
        return {
          success: false,
          text: `Which timezone should I use for ${requestedTime} on "${target.definition.title}"?`,
        };
      }
      const request: UpdateLifeOpsDefinitionRequest = {
        ownership,
        title:
          params.title !== target.definition.title ? params.title : undefined,
        timezone: requestedTimeZone ?? undefined,
        description: detailString(details, "description"),
        cadence: normalizeCadenceDetail(detailObject(details, "cadence")),
        priority: detailNumber(details, "priority"),
        // detailObject returns Record<string,unknown>; cast at validated boundary.
        windowPolicy: detailObject(
          details,
          "windowPolicy",
        ) as UpdateLifeOpsDefinitionRequest["windowPolicy"],
        reminderPlan: detailObject(
          details,
          "reminderPlan",
        ) as UpdateLifeOpsDefinitionRequest["reminderPlan"],
      };

      if (request.cadence == null && intent) {
        const llmFields = await extractUpdateFieldsWithLlm({
          runtime,
          intent,
          currentTitle: target.definition.title,
          currentCadenceKind: target.definition.cadence.kind,
          currentWindows: target.definition.windowPolicy.windows.map(
            (w) => w.name,
          ),
        });
        if (llmFields) {
          if (llmFields.title) request.title = llmFields.title;
          if (llmFields.priority) request.priority = llmFields.priority;
          if (llmFields.description)
            request.description = llmFields.description;
          if (
            llmFields.cadenceKind ||
            llmFields.windows ||
            llmFields.weekdays ||
            llmFields.everyMinutes ||
            llmFields.timeOfDay ||
            llmFields.dueDate ||
            llmFields.dueInDays !== null ||
            llmFields.dueWeekday !== null ||
            llmFields.dueInMinutes !== null
          ) {
            const built = buildCadenceFromUpdateFields({
              currentCadence: target.definition.cadence,
              currentWindowPolicy: target.definition.windowPolicy,
              timeZone: requestedTimeZone ?? target.definition.timezone,
              update: llmFields,
            });
            if (built) {
              request.cadence = built.cadence;
              request.windowPolicy = built.windowPolicy;
            }
          }
        }
      }

      if (!hasDefinitionUpdateChanges(request)) {
        return {
          success: false,
          text: `Tell me what to change about "${target.definition.title}" and I'll update it.`,
        };
      }

      const claim = await service.repository.claimDefinitionMutation({
        scope: mutationScope,
        requestId,
        operation: "update_definition",
        definitionId: target.definition.id,
        expectedRevision: definitionRevision(target),
        observedAt: lifeEffectObservedAt(message, null),
      });
      if (claim.disposition !== "claimed") {
        return {
          success: false,
          text:
            claim.disposition === "pending"
              ? "That update is already in progress. I will not apply it twice."
              : claim.disposition === "completed"
                ? "That update was already applied."
                : "That update previously failed and was not retried automatically.",
        };
      }
      let updated: LifeOpsDefinitionRecord;
      try {
        updated = await service.updateDefinition(target.definition.id, request);
        await service.repository.completeDefinitionMutation({
          entry: claim.entry,
          resultRevision: definitionRevision(updated),
          result: {
            definitionId: updated.definition.id,
            title: updated.definition.title,
          },
        });
      } catch (error) {
        await service.repository.failDefinitionMutation({
          entry: claim.entry,
          failureCode: definitionMutationFailureCode(error),
        });
        throw error;
      }
      const fallback = `Updated "${updated.definition.title}".`;
      const text = await renderLifeActionReply({
        runtime,
        message,
        state,
        intent,
        scenario: "updated_definition",
        fallback,
        context: {
          previousTitle: target.definition.title,
          updated: {
            title: updated.definition.title,
          },
        },
      });
      return {
        success: true,
        text,
        userFacingText: text,
        verifiedUserFacing: true,
        data: toActionData({
          ...updated,
          mutationObservedAt: claim.entry.observedAt,
        }),
      };
    }

    if (internalOp === "update_goal") {
      const target = await resolveGoal(service, targetName, domain);
      if (!target)
        return {
          success: false,
          text: "I could not find that goal to update.",
        };
      const request: UpdateLifeOpsGoalRequest = {
        ownership,
        title: params.title !== target.goal.title ? params.title : undefined,
        description: detailString(details, "description"),
        cadence: normalizeCadenceDetail(
          detailObject(details, "cadence"),
        ) as UpdateLifeOpsGoalRequest["cadence"],
        supportStrategy: detailObject(details, "supportStrategy"),
        successCriteria: detailObject(details, "successCriteria"),
      };
      const hasExplicitGoalChanges =
        request.title !== undefined ||
        request.description !== undefined ||
        request.cadence !== undefined ||
        request.supportStrategy !== undefined ||
        request.successCriteria !== undefined;
      if (!hasExplicitGoalChanges) {
        const llmPlan = await extractGoalUpdatePlanWithLlm({
          runtime,
          currentGoal: target.goal,
          intent,
          state: state ?? undefined,
          message: message,
        });
        if (llmPlan.mode === "respond") {
          return {
            success: true,
            text:
              llmPlan.response ??
              `Tell me what to change about "${target.goal.title}" and I'll update it.`,
            data: {
              actionName: ownerSurfaceActionName,
              noop: true,
              suggestedOperation: "update_goal",
            },
          };
        }
        if (llmPlan.title) request.title = llmPlan.title;
        if (llmPlan.description) request.description = llmPlan.description;
        if (llmPlan.cadence) request.cadence = llmPlan.cadence;
        if (llmPlan.supportStrategy)
          request.supportStrategy = llmPlan.supportStrategy;
        if (llmPlan.successCriteria)
          request.successCriteria = llmPlan.successCriteria;
        if (llmPlan.groundingState) {
          request.metadata = mergeGoalMetadataWithGrounding({
            metadata: target.goal.metadata,
            nowIso: new Date().toISOString(),
            plan: {
              cadence: llmPlan.cadence,
              confidence: llmPlan.confidence,
              evaluationSummary: llmPlan.evaluationSummary,
              groundingState: llmPlan.groundingState,
              missingCriticalFields: llmPlan.missingCriticalFields,
              successCriteria:
                llmPlan.successCriteria ?? target.goal.successCriteria,
              targetDomain: llmPlan.targetDomain,
            },
          });
        }
      }
      if (
        request.title === undefined &&
        request.description === undefined &&
        request.cadence === undefined &&
        request.supportStrategy === undefined &&
        request.successCriteria === undefined &&
        request.metadata === undefined
      ) {
        return {
          success: false,
          text: `Tell me what to change about "${target.goal.title}" and I'll update it.`,
        };
      }
      const updated = await service.updateGoal(target.goal.id, request);
      const fallback = `Updated goal "${updated.goal.title}".`;
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "updated_goal",
          fallback,
          context: {
            previousTitle: target.goal.title,
            updated: {
              title: updated.goal.title,
            },
          },
        }),
        data: toActionData(updated),
      };
    }

    if (internalOp === "delete_definition") {
      if (isBroadLifeDeleteRequest({ intent, targetName })) {
        const fallback =
          "I won't delete everything from a moment like this. I can pause or snooze things while you take a breath, or delete one specific item if you name it.";
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "reply_only",
            fallback,
            context: {
              reason: "blocked_broad_destructive_delete",
              target: targetName ?? null,
            },
          }),
          data: {
            actionName: ownerSurfaceActionName,
            noop: true,
            blockedReason: "broad_destructive_delete",
          },
        };
      }
      const mutationScope = definitionMutationScope({
        runtime,
        message,
        domain,
      });
      const requestId = lifeEffectRequestId(message);
      const priorMutation = await service.repository.getDefinitionMutation({
        scope: mutationScope,
        requestId,
        operation: "delete_definition",
      });
      if (priorMutation?.status === "completed") {
        const deletedTitle =
          typeof priorMutation.result?.title === "string"
            ? priorMutation.result.title
            : "the selected item";
        const fallback = `Deleted "${deletedTitle}" and its occurrences.`;
        const text = await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "deleted_definition",
          fallback,
          context: { deleted: { title: deletedTitle } },
        });
        return {
          success: true,
          text,
          userFacingText: text,
          verifiedUserFacing: true,
          data: {
            actionName: ownerSurfaceActionName,
            deduplicated: true,
            mutationObservedAt: priorMutation.observedAt,
            deleted: {
              kind: "definition",
              id: priorMutation.definitionId,
              title: deletedTitle,
            },
          },
        };
      }
      if (priorMutation) {
        return {
          success: false,
          text:
            priorMutation.status === "pending"
              ? "That deletion is already in progress. I will not apply it twice."
              : "That deletion previously failed and was not retried automatically.",
        };
      }
      const { match: target, ambiguousCandidates } =
        await resolveDefinitionForMutation(
          service,
          targetName,
          messageText(message) || intent,
          domain,
        );
      if (!target) {
        return {
          success: false,
          text:
            ambiguousCandidates.length > 0
              ? `Please name the exact item to delete:\n${ambiguousCandidates.map((title) => `  - ${title}`).join("\n")}`
              : "I could not ground that deletion in an item you explicitly named.",
        };
      }
      const claim = await service.repository.claimDefinitionMutation({
        scope: mutationScope,
        requestId,
        operation: "delete_definition",
        definitionId: target.definition.id,
        expectedRevision: definitionRevision(target),
        observedAt: lifeEffectObservedAt(message, null),
      });
      if (claim.disposition !== "claimed") {
        return {
          success: false,
          text:
            claim.disposition === "pending"
              ? "That deletion is already in progress. I will not apply it twice."
              : claim.disposition === "completed"
                ? "That deletion was already applied."
                : "That deletion previously failed and was not retried automatically.",
        };
      }
      try {
        await service.deleteDefinition(target.definition.id);
        await service.repository.completeDefinitionMutation({
          entry: claim.entry,
          resultRevision: null,
          result: {
            definitionId: target.definition.id,
            title: target.definition.title,
          },
        });
      } catch (error) {
        await service.repository.failDefinitionMutation({
          entry: claim.entry,
          failureCode: definitionMutationFailureCode(error),
        });
        throw error;
      }
      const fallback = `Deleted "${target.definition.title}" and its occurrences.`;
      const text = await renderLifeActionReply({
        runtime,
        message,
        state,
        intent,
        scenario: "deleted_definition",
        fallback,
        context: {
          deleted: {
            title: target.definition.title,
          },
        },
      });
      return {
        success: true,
        text,
        userFacingText: text,
        verifiedUserFacing: true,
        data: {
          actionName: ownerSurfaceActionName,
          mutationObservedAt: claim.entry.observedAt,
          deleted: {
            kind: "definition",
            id: target.definition.id,
            title: target.definition.title,
          },
        },
      };
    }

    if (internalOp === "delete_goal") {
      if (isBroadLifeDeleteRequest({ intent, targetName })) {
        const fallback =
          "I won't delete every goal from a moment like this. I can help pause the pressure or delete one specific goal if you name it.";
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "reply_only",
            fallback,
            context: {
              reason: "blocked_broad_destructive_delete",
              target: targetName ?? null,
            },
          }),
          data: {
            actionName: ownerSurfaceActionName,
            noop: true,
            blockedReason: "broad_destructive_delete",
          },
        };
      }
      const target = await resolveGoal(service, targetName, domain);
      if (!target)
        return {
          success: false,
          text: "I could not find that goal to delete.",
        };
      await service.deleteGoal(target.goal.id);
      const fallback = `Deleted goal "${target.goal.title}".`;
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "deleted_goal",
          fallback,
          context: {
            deleted: {
              title: target.goal.title,
            },
          },
        }),
        data: {
          actionName: ownerSurfaceActionName,
          deleted: {
            kind: "goal",
            id: target.goal.id,
            title: target.goal.title,
          },
        },
      };
    }

    if (internalOp === "complete_occurrence") {
      // Direct occurrenceId path: when the planner already knows the
      // occurrence id we skip title/intent matching.
      const directOccurrenceId = detailString(details, "occurrenceId");
      let resolvedTargetId: string;
      if (directOccurrenceId) {
        resolvedTargetId = directOccurrenceId;
      } else {
        const { match: target, ambiguousCandidates } =
          await resolveOccurrenceWithIntentFallback({
            service,
            target: targetName,
            domain,
            intent,
            operation,
          });
        if (!target) {
          if (ambiguousCandidates.length > 0) {
            return {
              success: false,
              text: `Multiple items match — which one?\n${ambiguousCandidates.map((t) => `  - ${t}`).join("\n")}`,
            };
          }
          return {
            success: false,
            text: "I could not find that active item to complete.",
          };
        }
        resolvedTargetId = target.id;
      }
      const priorOccurrence = await service.repository.getOccurrence(
        runtime.agentId,
        resolvedTargetId,
      );
      const completed = await service.completeOccurrence(resolvedTargetId, {
        note: detailString(details, "note"),
      });
      const effectReplayed = priorOccurrence?.state === "completed";
      const fallback = effectReplayed
        ? `"${completed.title}" was already marked done — nothing changed.`
        : `Marked "${completed.title}" done.`;
      return {
        success: true,
        text: effectReplayed
          ? fallback
          : await renderLifeActionReply({
              runtime,
              message,
              state,
              intent,
              scenario: "completed_occurrence",
              fallback,
              context: {
                completed: {
                  title: completed.title,
                },
                note: detailString(details, "note"),
              },
            }),
        data: toActionData({
          ...completed,
          effectReplayed,
        }),
      };
    }

    if (internalOp === "skip_occurrence") {
      const { match: target, ambiguousCandidates } =
        await resolveOccurrenceWithIntentFallback({
          service,
          target: targetName,
          domain,
          intent,
          operation,
        });
      if (!target) {
        if (ambiguousCandidates.length > 0) {
          return {
            success: false,
            text: `Multiple items match — which one?\n${ambiguousCandidates.map((t) => `  - ${t}`).join("\n")}`,
          };
        }
        return {
          success: false,
          text: "I could not find that active item to skip.",
        };
      }
      const skipped = await service.skipOccurrence(target.id);
      const fallback = `Skipped "${skipped.title}".`;
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "skipped_occurrence",
          fallback,
          context: {
            skipped: {
              title: skipped.title,
            },
          },
        }),
        data: toActionData({
          ...skipped,
          effectReplayed: target.state === "skipped",
        }),
      };
    }

    if (internalOp === "snooze_occurrence") {
      // Direct occurrenceId path for reminder_snooze.
      const directOccurrenceId = detailString(details, "occurrenceId");
      let resolvedTargetId: string;
      if (directOccurrenceId) {
        resolvedTargetId = directOccurrenceId;
      } else {
        const { match: target, ambiguousCandidates } =
          await resolveOccurrenceWithIntentFallback({
            service,
            target: targetName,
            domain,
            intent,
            operation,
          });
        if (!target) {
          if (ambiguousCandidates.length > 0) {
            return {
              success: false,
              text: `Multiple items match — which one?\n${ambiguousCandidates.map((t) => `  - ${t}`).join("\n")}`,
            };
          }
          return {
            success: false,
            text: "I could not find that active item to snooze.",
          };
        }
        resolvedTargetId = target.id;
      }
      const preset =
        normalizeSnoozePreset(detailString(details, "preset")) ??
        normalizeSnoozePreset(params.preset) ??
        normalizeSnoozePreset(routedParams?.preset);
      const minutes =
        detailNumber(details, "minutes") ??
        normalizeSnoozeMinutes(params.minutes) ??
        normalizeSnoozeMinutes(routedParams?.minutes);
      const snoozed = await service.snoozeOccurrence(resolvedTargetId, {
        preset,
        minutes,
      });
      const fallback = `Snoozed "${snoozed.title}".`;
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "snoozed_occurrence",
          fallback,
          context: {
            snoozed: {
              title: snoozed.title,
            },
            preset: preset ?? null,
            minutes: minutes ?? null,
          },
        }),
        data: toActionData(snoozed),
      };
    }

    if (internalOp === "review_goal") {
      const target = await resolveGoal(service, targetName, domain);
      if (!target) {
        const weeklyReview = await service.reviewGoalsForWeek();
        if (weeklyReview.summary.totalGoals === 0) {
          // No goals to review — fall through to overview so task-list-style
          // queries like "what's on my task item list today?" still resolve.
          const overview = await service.getOverview();
          const userQuery = messageText(message) || intent || "overview";
          const fallback = formatOverviewForQuery(overview, userQuery);
          return {
            success: true,
            text: await renderLifeActionReply({
              runtime,
              message,
              state,
              intent: userQuery,
              scenario: "overview",
              fallback,
              context: {
                summary: overview.owner.summary,
                occurrenceTitles: overview.owner.occurrences
                  .slice(0, 6)
                  .map((occurrence) => occurrence.title),
                goalTitles: overview.owner.goals
                  .slice(0, 3)
                  .map((goal) => goal.title),
              },
            }),
            data: toActionData(overview),
          };
        }
        const fallback = formatWeeklyGoalReview(weeklyReview);
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "weekly_goal_review",
            fallback,
            context: {
              summary: weeklyReview.summary,
              atRiskTitles: weeklyReview.atRisk
                .slice(0, 3)
                .map((review) => review.goal.title),
              needsAttentionTitles: weeklyReview.needsAttention
                .slice(0, 3)
                .map((review) => review.goal.title),
              onTrackTitles: weeklyReview.onTrack
                .slice(0, 3)
                .map((review) => review.goal.title),
            },
          }),
          data: toActionData(weeklyReview),
        };
      }
      const review = await service.reviewGoal(target.goal.id);
      return {
        success: true,
        text: review.summary.explanation,
        data: toActionData(review),
      };
    }

    if (internalOp === "policy_set_reminder") {
      const intensityDetail = detailString(details, "intensity");
      const intensity =
        intensityDetail === "minimal" ||
        intensityDetail === "normal" ||
        intensityDetail === "persistent" ||
        intensityDetail === "high_priority_only"
          ? intensityDetail
          : undefined;
      return applyOwnerPolicySetReminder({
        runtime,
        message,
        intent,
        resolveDefinition: resolveDefinitionFromIntent,
        intensity,
        target: targetName,
        details,
      });
    }

    if (internalOp === "policy_configure_escalation") {
      return applyOwnerPolicyConfigureEscalation({
        runtime,
        message,
        intent,
        resolveDefinition: resolveDefinitionFromIntent,
        target: targetName,
        timeoutMinutes: detailNumber(details, "timeoutMinutes"),
        callAfterMinutes: detailNumber(details, "callAfterMinutes"),
        details,
      });
    }

    return {
      success: false,
      text: "I didn't understand that life management request.",
    };
  } catch (err) {
    // error-policy:J1 The action boundary translates typed domain failures into a rejected user-visible operation.
    if (err instanceof LifeOpsServiceError) {
      logger.error(
        {
          boundary: "lifeops-owner-action",
          operation,
          status: err.status,
          err,
        },
        `[LifeAction] ${operation ?? "unknown"} failed: ${err.message}`,
      );
      const fallback = buildLifeServiceErrorFallback(err, intent);
      return {
        success: false,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "service_error",
          fallback,
          context: {
            status: err.status,
            operation,
          },
        }),
        data: {
          actionName: ownerSurfaceActionName,
          error: "LIFEOPS_SERVICE_ERROR",
          status: err.status,
        },
      };
    }
    throw err;
  }
}

export async function runLifeOperationHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const result = await runLifeOperationHandlerInner(
    runtime,
    message,
    state,
    options,
  );
  return completeLifeOpsEffect(
    callback,
    result,
    await lifeEffectReceiptForResult({
      runtime,
      message,
      options,
      result,
    }),
  );
}
