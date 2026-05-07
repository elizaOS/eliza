import { renderGroundedActionReply } from "@elizaos/agent/actions/grounded-action-reply";
import {
  extractConversationMetadataFromRoom,
  isPageScopedConversationMetadata,
} from "@elizaos/agent/api/conversation-metadata";
import type {
  Action,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
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
  buildNativeAppleReminderMetadata,
  type NativeAppleReminderLikeKind,
} from "../lifeops/apple-reminders.js";
import {
  resolveDefaultTimeZone,
  resolveDefaultWindowPolicy,
} from "../lifeops/defaults.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
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
  countTurnsSinceLatestDeferredLifeDraft,
  type DeferredLifeDefinitionDraft,
  type DeferredLifeDraft,
  type DeferredLifeDraftFollowupMode,
  type DeferredLifeDraftReuseMode,
  type DeferredLifeGoalDraft,
  deferredLifeDraftExpiryReason,
  extractDeferredLifeDraftFollowupWithLlm,
  latestDeferredLifeDraft,
} from "./lib/lifeops-deferred-draft.js";
import {
  resolveActionArgs,
  type SubactionsMap,
} from "./lib/resolve-action-args.js";
import {
  detailBoolean,
  detailNumber,
  detailObject,
  detailString,
  formatOverviewForQuery,
  messageText,
  toActionData,
} from "./lifeops-google-helpers.js";
import { looksLikeCodingTaskRequest } from "./non-actionable-request.js";
import { normalizeExplicitTimeZoneToken } from "./timezone-normalization.js";

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
  operation: LifeOwnedOperation | null;
  kind?: LifeKind;
  shouldAct: boolean;
};

type LifeParams = {
  subaction?: LifeOperation;
  kind?: LifeKind;
  intent?: string;
  title?: string;
  target?: string;
  minutes?: number;
  details?: Record<string, unknown>;
};

const SUBACTIONS = {
  create: {
    description:
      "Create a life-item: kind=definition (habit/routine/reminder/alarm/todo) or kind=goal (long-term aspiration).",
    descriptionCompressed:
      "create life-item: kind=definition(habit/routine/reminder/alarm/todo) or goal; cadence/title/details from intent",
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
    description: "Snooze an occurrence by minutes or preset duration.",
    descriptionCompressed: "snooze occurrence; duration",
    required: ["target"],
    optional: ["minutes"],
  },
  review: {
    description: "Review progress on a goal.",
    descriptionCompressed: "review goal progress",
    required: ["target"],
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
  | "review_goal";

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

const GENERIC_DERIVED_TITLE_RE =
  /^(?:new\s+)?(?:habit|routine|task|goal|life goal|thing|item|something|anything|stuff|plan|reminder|todo|to do|achieve|achieve a|achieve an)$/i;

function normalizeLifeTimeZoneToken(
  value: string | null | undefined,
): string | null {
  return normalizeExplicitTimeZoneToken(value);
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

async function resolveLifeOperationPlan(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  explicitOperation: LifeOwnedOperation | undefined;
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
 * Pre-routing pick of the LIFE subaction.
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
  explicitSubaction: LifeOwnedOperation | undefined;
}): Promise<ResolvedLifeOperationPlan> {
  const { runtime, message, state, options, intent, explicitSubaction } = args;
  const resolved = await resolveActionArgs<LifeOwnedOperation, LifeParams>({
    runtime,
    message,
    state,
    options,
    actionName: "LIFE",
    subactions: SUBACTIONS,
    intentHint: intent,
  });

  if (resolved.ok) {
    return {
      operation: resolved.subaction,
      confidence: 1,
      missing: [],
      shouldAct: true,
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

  if (
    args.explicitOperation &&
    args.explicitOperation !== args.draft.operation
  ) {
    return null;
  }

  if (args.llmMode === "confirm" || args.llmMode === "edit") {
    return args.llmMode;
  }
  return null;
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

function requestedOwnership(domain?: LifeOpsDomain) {
  if (domain === "agent_ops") {
    return { domain: "agent_ops" as const, subjectType: "agent" as const };
  }
  return { domain: "user_lifeops" as const, subjectType: "owner" as const };
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

function normalizeTitle(value: string): string {
  return normalizeIntentText(value);
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
        .map((slot) => slot.label?.trim() || `${slot.minuteOfDay}`)
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
  return renderGroundedActionReply({
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

function extractExplicitDailySlots(intent: string): LifeOpsDailySlot[] {
  const tokens = [
    ...intent.matchAll(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight)\b/gi),
  ]
    .map((match) => match[1])
    .filter(
      (token): token is string => typeof token === "string" && token.length > 0,
    );
  const seen = new Set<number>();
  const slots: LifeOpsDailySlot[] = [];
  for (const [index, token] of tokens.entries()) {
    const minuteOfDay = parseClockToken(token);
    if (minuteOfDay === null || seen.has(minuteOfDay)) {
      continue;
    }
    seen.add(minuteOfDay);
    slots.push({
      key: `clock-${index + 1}`,
      label: token.trim(),
      minuteOfDay,
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
 * valid cadence, letting the caller fall back to regex-derived values.
 */
function buildCadenceFromLlmParams(
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
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "once",
          dueAt: buildOneOffDueAtFromMinuteOfDay({
            minuteOfDay: timeOfDayMinute,
            now: context?.now,
            timeZone: effectiveTimeZone,
          }),
        },
      };
    }
    return { cadence: { kind: "once", dueAt: new Date().toISOString() } };
  }
  if (kind === "daily") {
    if (explicitSlots.length >= 2) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: explicitSlots.map((slot) => ({
            ...slot,
            durationMinutes: slot.durationMinutes ?? slotDuration,
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
            durationMinutes: slot.durationMinutes ?? slotDuration,
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

function buildCadenceFromUpdateFields(args: {
  currentCadence: LifeOpsCadence;
  currentWindowPolicy: LifeOpsWindowPolicy;
  update: ExtractedUpdateFields;
  timeZone: string;
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

  return currentCadence.kind === "once" ? { cadence: currentCadence } : null;
}

function hasDefinitionUpdateChanges(
  request: UpdateLifeOpsDefinitionRequest,
): boolean {
  return (
    request.title != null ||
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
}): boolean {
  if (args.messageSource === "autonomy") {
    return false;
  }
  if (args.requestKind && args.cadence?.kind === "once") {
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

// LIFE belongs to the LifeOps surface (home chat / page-lifeops /
// app-lifeops direct rooms). On foreign page-* scopes the action set is
// scoped to that surface (page-automations → CREATE_TRIGGER_TASK,
// page-browser → browser actions, etc.). When LIFE stays eligible on those
// scopes its long description contaminates the ACTION_PLANNER candidate
// list, driving the LLM to mimic the life-param-extractor structured schema and
// producing envelopes the planner cannot read.
async function isForeignPageScope(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> {
  const room = await runtime.getRoom(message.roomId);
  const metadata = extractConversationMetadataFromRoom(room);
  if (!isPageScopedConversationMetadata(metadata)) {
    return false;
  }
  return metadata?.scope !== "page-lifeops";
}

export const lifeAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "LIFE",
  similes: [
    "TODO",
    "TODOS",
    "HABIT",
    "HABITS",
    "GOAL",
    "GOALS",
    "REMINDER",
    "REMINDERS",
    "ALARM",
    "ROUTINE",
    "TASK",
    "TRACK_HABIT",
    "MARK_DONE",
    "SNOOZE",
    "SET_REMINDER",
    "NEW_HABIT",
    "NEW_GOAL",
  ],
  description:
    "Owner-only. Personal life management: create/update/delete habits, routines, reminders, alarms, todos, and long-term goals; mark occurrences complete/skip/snooze; review goal progress. Owner profile persistence (phone, escalation rules, reminder preferences) lives in PROFILE. Calendar/email/overview queries belong to CALENDAR and CHECKIN — do not invoke LIFE for those.",
  descriptionCompressed:
    "life: create update delete (kind=definition|goal) + occurrence complete skip snooze + goal review",
  contexts: ["tasks", "calendar", "health"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => {
    if (looksLikeCodingTaskRequest(messageText(message))) {
      return false;
    }
    if (await isForeignPageScope(runtime, message)) {
      return false;
    }
  },
  handler: async (runtime, message, state, options) => {
    // Defense-in-depth at dispatch time: validate() above excludes LIFE
    // from the ACTION_PLANNER candidate list on foreign page-* scopes, but
    // runtime.processActions dispatches by name/simile WITHOUT re-calling
    // validate. When the LLM emits LIFE or a LIFE simile directly, the
    // handler still fires. This guard mirrors validate()'s scope check so
    // LIFE stays a no-op on foreign page-* scopes regardless of how it got
    // dispatched. Returns empty text so the runtime callback does not
    // render a user-visible message — any streamed tokens from the outer
    // LLM reply already landed before this handler runs.
    if (await isForeignPageScope(runtime, message)) {
      return {
        success: false,
        text: "",
        data: {
          actionName: "LIFE",
          reason: "foreign_page_scope",
        },
      };
    }

    const rawParams = (options as HandlerOptions | undefined)?.parameters as
      | LifeParams
      | undefined;
    const params = rawParams ?? ({} as LifeParams);
    const currentText = normalizeLifeInputText(messageText(message));
    const details = params.details;
    const deferredDraft = latestDeferredLifeDraft(state);
    const turnsSinceDraft =
      deferredDraft != null
        ? (countTurnsSinceLatestDeferredLifeDraft(state) ?? 0) + 1
        : undefined;
    const deferredDraftFollowupMode = deferredDraft
      ? await extractDeferredLifeDraftFollowupWithLlm({
          runtime,
          message,
          state,
          currentText,
          draft: deferredDraft,
        })
      : null;
    const draftExpiryReason = deferredLifeDraftExpiryReason({
      draft: deferredDraft,
      turnsSinceDraft,
    });
    if (draftExpiryReason && deferredDraftFollowupMode === "confirm") {
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
          actionName: "LIFE",
          noop: true,
        },
      };
    }
    const explicitSubaction =
      typeof params.subaction === "string" &&
      Object.hasOwn(SUBACTIONS, params.subaction)
        ? (params.subaction as LifeOwnedOperation)
        : undefined;
    const deferredDraftReuseMode = resolveDeferredLifeDraftReuseMode({
      details,
      draft: deferredDraft,
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
    // shared LLM pre-routing substrate). The legacy extractLifeOperationWithLlm
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
    const resolvedKind: LifeKind | undefined =
      operationPlan.kind ?? explicitKind;
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
      return {
        success: true,
        text: await renderLifeActionReply({
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
        }),
        data: {
          actionName: "LIFE",
          noop: true,
          suggestedOperation: operationPlan.operation,
        },
      };
    }
    const operation: LifeOwnedOperation | null = forceCreateExecution
      ? "create"
      : operationPlan.operation;
    // Internal handler dispatch key (definition vs goal split lives here).
    // For create/update/delete, infer kind from explicit param, plan, draft, or
    // intent; for occurrence-level verbs the kind is irrelevant.
    const kind: LifeKind =
      resolvedKind ??
      (operation === "create" ||
      operation === "update" ||
      operation === "delete"
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
          actionName: "LIFE",
          noop: true,
        },
      };
    }
    const service = new LifeOpsService(runtime);
    const domain = detailString(details, "domain") as LifeOpsDomain | undefined;
    const ownership = requestedOwnership(domain);
    const targetName = params.target ?? params.title;
    const createConfirmed =
      deferredDraftReuseMode === "confirm" ||
      detailBoolean(details, "confirmed") === true;

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
          params.title &&
            explicitCadenceDetail &&
            detailString(details, "kind"),
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
          ? ((detailObject(details, "windowPolicy") as unknown as
              | CreateLifeOpsDefinitionRequest["windowPolicy"]
              | undefined) ?? deferredDefinitionDraft?.request.windowPolicy)
          : (deferredDefinitionDraft?.request.windowPolicy ??
            (detailObject(details, "windowPolicy") as unknown as
              | CreateLifeOpsDefinitionRequest["windowPolicy"]
              | undefined));
        const explicitPriority = detailNumber(details, "priority");
        const explicitDescription = detailString(details, "description");
        const explicitMetadata = detailObject(details, "metadata") as
          | Record<string, unknown>
          | undefined;

        // Track whether cadence/title came from explicit high-confidence
        // sources so the planner only fills genuine gaps.
        const hadExplicitCadence = Boolean(
          (editingDeferredDefinitionDraft
            ? (explicitCadenceDetail ??
              deferredDefinitionDraft?.request.cadence)
            : deferredDefinitionDraft?.request.cadence) ??
            explicitCadenceDetail,
        );
        const hadExplicitTitle = Boolean(
          (editingDeferredDefinitionDraft
            ? params.title
            : deferredDefinitionDraft?.request.title) ?? params.title,
        );

        // ── Legacy parameter enhancement (fills gaps) ─────
        // Skip when native options.parameters already contain the complete
        // definition-create shape, or when reusing a confirmed deferred draft.
        // TODO(native-parameters): delete this extractor once planners supply
        // title/details.cadence/details.kind consistently.
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
            message: message ?? undefined,
          });
          const shouldHonorPlannerResponse =
            llmPlan?.mode === "respond" &&
            Boolean(llmPlan.response) &&
            !editingDeferredDefinitionDraft &&
            !params.title &&
            !explicitCadenceDetail &&
            !detailString(details, "description") &&
            !detailString(details, "goalId") &&
            !detailString(details, "goalTitle") &&
            !detailString(details, "kind");
          if (shouldHonorPlannerResponse && llmPlan?.response) {
            return {
              success: true as const,
              text: llmPlan.response,
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
              const llmCadenceTimeZone = normalizeLifeTimeZoneToken(
                detailString(details, "timeZone") ??
                  llmPlan.timeZone ??
                  deferredDefinitionDraft?.request.timezone ??
                  windowPolicy?.timezone,
              );
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
        const resolvedTimeZone = normalizeLifeTimeZoneToken(
          detailString(details, "timeZone") ??
            llmPlan?.timeZone ??
            deferredDefinitionDraft?.request.timezone ??
            windowPolicy?.timezone,
        );
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
              deferredDefinitionDraft?.request.metadata,
              mergeMetadataRecords(explicitMetadata, nativeAppleMetadata),
            )
          : (deferredDefinitionDraft?.request.metadata ??
            mergeMetadataRecords(explicitMetadata, nativeAppleMetadata));

        if (!title) {
          const fallback = "What should I call it?";
          return {
            success: false as const,
            text: await renderLifeActionReply({
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
            }),
            // Asking the owner to fill in a missing field — selection +
            // execution were both correct, terminal state is "needs human
            // input". Flag so the native planner chain breaks and the spy
            // scores this as completed.
            values: {
              success: false,
              error: "MISSING_DEFINITION_FIELD",
              missingField: "title",
              requiresConfirmation: true,
            },
            data: {
              actionName: "LIFE",
              missingField: "title",
              requiresConfirmation: true,
            },
          };
        }
        if (!cadence) {
          const fallback = "When should it happen?";
          return {
            success: false as const,
            text: await renderLifeActionReply({
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
            }),
            values: {
              success: false,
              error: "MISSING_DEFINITION_FIELD",
              missingField: "schedule",
              requiresConfirmation: true,
            },
            data: {
              actionName: "LIFE",
              missingField: "schedule",
              requiresConfirmation: true,
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
        const definitionDraft: DeferredLifeDefinitionDraft = {
          intent,
          operation: "create_definition",
          createdAt: editingDeferredDefinitionDraft
            ? Date.now()
            : (deferredDefinitionDraft?.createdAt ?? Date.now()),
          request: {
            cadence,
            description:
              explicitDescription ??
              llmDescription ??
              (editingDeferredDefinitionDraft
                ? deferredDefinitionDraft?.request.description
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
            reminderPlan:
              (detailObject(details, "reminderPlan") as
                | CreateLifeOpsDefinitionRequest["reminderPlan"]
                | undefined) ??
              deferredDefinitionDraft?.request.reminderPlan ??
              buildDefaultReminderPlan(`${title} reminder`),
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
            websiteAccess:
              (detailObject(details, "websiteAccess") as unknown as
                | CreateLifeOpsDefinitionRequest["websiteAccess"]
                | undefined) ?? deferredDefinitionDraft?.request.websiteAccess,
          },
        };
        if (
          shouldRequireLifeCreateConfirmation({
            confirmed: createConfirmed,
            messageSource:
              typeof message.content?.source === "string"
                ? message.content.source
                : undefined,
            requestKind: timedRequestKind,
            cadence: definitionDraft.request.cadence,
          })
        ) {
          const fallback = `I can save this as a ${definitionDraft.request.kind} named "${definitionDraft.request.title}" that happens ${summarizeCadence(definitionDraft.request.cadence)}. Confirm and I'll save it, or tell me what to change.`;
          return {
            success: true as const,
            text: await renderLifeActionReply({
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
            }),
            data: {
              actionName: "LIFE",
              deferred: true,
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

        const created = await service.createDefinition({
          ownership,
          kind: definitionDraft.request.kind,
          title: definitionDraft.request.title,
          description: definitionDraft.request.description,
          originalIntent:
            definitionDraft.intent || definitionDraft.request.title,
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
        const fallback = `Saved "${created.definition.title}" as ${summarizeCadence(created.definition.cadence)}.`;
        return {
          success: true as const,
          text: await renderLifeActionReply({
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
              },
              requestKind: timedRequestKind,
            },
          }),
          data: toActionData(created),
        };
      };

      // ── Mutations ───────────────────────────────────

      if (internalOp === "create_definition") {
        return await createDefinition();
      }

      if (internalOp === "create_goal") {
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
          ? (params.title ?? deferredGoalDraft?.request.title ?? null)
          : (deferredGoalDraft?.request.title ?? params.title ?? null);
        let description: string | undefined = editingDeferredGoalDraft
          ? (explicitDescription ?? deferredGoalDraft?.request.description)
          : (deferredGoalDraft?.request.description ?? explicitDescription);
        let cadence = editingDeferredGoalDraft
          ? (explicitCadence ?? deferredGoalDraft?.request.cadence)
          : (deferredGoalDraft?.request.cadence ?? explicitCadence);
        let successCriteria = editingDeferredGoalDraft
          ? (explicitSuccessCriteria ??
            deferredGoalDraft?.request.successCriteria)
          : (deferredGoalDraft?.request.successCriteria ??
            explicitSuccessCriteria);
        let supportStrategy = editingDeferredGoalDraft
          ? (explicitSupportStrategy ??
            deferredGoalDraft?.request.supportStrategy)
          : (deferredGoalDraft?.request.supportStrategy ??
            explicitSupportStrategy);
        let goalMetadata: CreateLifeOpsGoalRequest["metadata"] | undefined =
          editingDeferredGoalDraft
            ? (explicitMetadata ?? deferredGoalDraft?.request.metadata)
            : (deferredGoalDraft?.request.metadata ?? explicitMetadata);
        let evaluationSummary: string | null = null;

        const hasExplicitGroundedGoal =
          Boolean(title) &&
          (createConfirmed ||
            (Boolean(successCriteria) && Boolean(supportStrategy)));

        if (
          (!deferredGoalDraft || editingDeferredGoalDraft) &&
          !hasExplicitGroundedGoal
        ) {
          const llmPlan = await extractGoalCreatePlanWithLlm({
            runtime,
            intent,
            state: state ?? undefined,
            message: message ?? undefined,
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
            // A clarification request is a successful outcome from the
            // agent's point of view — the agent chose to ask instead of
            // invent an ungrounded goal. Callers rely on `success: true +
            // data.noop: true` to distinguish a deliberate clarify from a
            // handler error.
            return {
              success: true,
              text:
                llmPlan.response ??
                "What would count as success for that goal, and over what time window?",
              values: {
                success: true,
                error: "NOOP_GOAL_UNGROUNDED",
                noop: true,
                suggestedOperation: "create_goal",
              },
              data: {
                actionName: "LIFE",
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
            confirmed: createConfirmed,
            messageSource:
              typeof message.content?.source === "string"
                ? message.content.source
                : undefined,
          })
        ) {
          const fallbackParts = [
            evaluationSummary
              ? `I can save "${goalDraft.request.title}" as a goal. Success looks like this: ${evaluationSummary} Confirm and I'll save it, or tell me what to change.`
              : `I can save this goal as "${goalDraft.request.title}". Confirm and I'll save it, or tell me what to change.`,
          ];
          const experienceSummary =
            formatGoalExperienceLoopSummary(experienceLoop);
          if (experienceSummary) {
            fallbackParts.push(experienceSummary);
          }
          return {
            success: true,
            text: await renderLifeActionReply({
              runtime,
              message,
              state,
              intent,
              scenario: "preview_goal",
              fallback: fallbackParts.join(" "),
              context: {
                draft: goalDraft.request,
                groundingSummary: evaluationSummary,
                experienceLoop,
              },
            }),
            data: {
              actionName: "LIFE",
              deferred: true,
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
        const fallback = experienceSummary
          ? `Saved goal "${created.goal.title}". ${experienceSummary}`
          : `Saved goal "${created.goal.title}".`;
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "saved_goal",
            fallback,
            context: {
              created: {
                title: created.goal.title,
                cadence: created.goal.cadence,
              },
              experienceLoop: createdExperienceLoop,
            },
          }),
          data: toActionData({
            ...created,
            experienceLoop: createdExperienceLoop,
          }),
        };
      }

      if (internalOp === "update_definition") {
        const target = await resolveDefinition(service, targetName, domain);
        if (!target)
          return {
            success: false,
            text: "I could not find that item to update.",
          };
        const request: UpdateLifeOpsDefinitionRequest = {
          ownership,
          title:
            params.title !== target.definition.title ? params.title : undefined,
          description: detailString(details, "description"),
          cadence: normalizeCadenceDetail(detailObject(details, "cadence")),
          priority: detailNumber(details, "priority"),
          windowPolicy: detailObject(
            details,
            "windowPolicy",
          ) as unknown as UpdateLifeOpsDefinitionRequest["windowPolicy"],
          reminderPlan: detailObject(
            details,
            "reminderPlan",
          ) as UpdateLifeOpsDefinitionRequest["reminderPlan"],
        };

        // If no explicit changes from structured details, try LLM extraction
        const hasExplicitChanges = hasDefinitionUpdateChanges(request);
        if (!hasExplicitChanges && intent) {
          const llmFields = await extractUpdateFieldsWithLlm({
            runtime,
            intent,
            currentTitle: target.definition.title,
            currentCadenceKind: target.definition.cadence.kind,
            currentWindows:
              target.definition.windowPolicy?.windows?.map((w) => w.name) ?? [],
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
              llmFields.timeOfDay
            ) {
              const built = buildCadenceFromUpdateFields({
                currentCadence: target.definition.cadence,
                currentWindowPolicy: target.definition.windowPolicy,
                timeZone: target.definition.timezone,
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

        const updated = await service.updateDefinition(
          target.definition.id,
          request,
        );
        const fallback = `Updated "${updated.definition.title}".`;
        return {
          success: true,
          text: await renderLifeActionReply({
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
          }),
          data: toActionData(updated),
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
          ) as unknown as UpdateLifeOpsGoalRequest["cadence"],
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
            message: message ?? undefined,
          });
          if (llmPlan.mode === "respond") {
            return {
              success: true,
              text:
                llmPlan.response ??
                `Tell me what to change about "${target.goal.title}" and I'll update it.`,
              data: {
                actionName: "LIFE",
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
        const target = await resolveDefinition(service, targetName, domain);
        if (!target)
          return {
            success: false,
            text: "I could not find that item to delete.",
          };
        await service.deleteDefinition(target.definition.id);
        const fallback = `Deleted "${target.definition.title}" and its occurrences.`;
        return {
          success: true,
          text: await renderLifeActionReply({
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
          }),
        };
      }

      if (internalOp === "delete_goal") {
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
        const completed = await service.completeOccurrence(resolvedTargetId, {
          note: detailString(details, "note"),
        });
        const fallback = `Marked "${completed.title}" done.`;
        return {
          success: true,
          text: await renderLifeActionReply({
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
          data: toActionData(completed),
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
          data: toActionData(skipped),
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
        const preset = detailString(details, "preset") as
          | "15m"
          | "30m"
          | "1h"
          | "tonight"
          | "tomorrow_morning"
          | undefined;
        const minutes = detailNumber(details, "minutes");
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
            // No goals to review — fall through to overview so todo-list-style
            // queries like "what's on my todo list today?" still resolve.
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

      return {
        success: false,
        text: "I didn't understand that life management request.",
      };
    } catch (err) {
      if (err instanceof LifeOpsServiceError) {
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
        };
      }
      throw err;
    }
  },
  parameters: [
    {
      name: "subaction",
      description: "Which life operation to perform.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "create",
          "update",
          "delete",
          "complete",
          "skip",
          "snooze",
          "review",
        ],
      },
    },
    {
      name: "kind",
      description:
        "For create/update/delete: 'definition' (habit/routine/reminder/alarm/todo) or 'goal' (long-term aspiration). Ignored for occurrence-level verbs (complete/skip/snooze) and review.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["definition", "goal"],
      },
    },
    {
      name: "intent",
      description:
        'Natural language description of what to do. Examples: "create a daily brushing habit for morning and night", "snooze brushing for 30 minutes".',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description:
        "Name for a new item, or the name of an existing item to act on.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "target",
      description: "Name or ID of an existing item to act on.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "minutes",
      description: "Snooze duration in minutes (alternative to a preset).",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "details",
      description:
        "Structured data when needed. May include: cadence schedule record, kind (task/habit/routine), description, priority, progressionRule, reminderPlan, confirmed (boolean when the user explicitly approves a previewed create), preset (snooze preset like 15m/30m/1h/tonight/tomorrow_morning), occurrenceId (target an existing occurrence directly for snooze/complete reminder mutations), goalId, goalTitle, supportStrategy, successCriteria, note, limit, domain (user_lifeops/agent_ops).",
      required: false,
      schema: { type: "object" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "add a todo: pick up dry cleaning tomorrow",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'I can save "Pick up dry cleaning" for tomorrow. Confirm and I\'ll save it.',
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "what's on my todo list today?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "You have 2 LifeOps items due today: pick up dry cleaning and call mom.",
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "set a goal to save $5,000 by the end of the year",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'I can save this goal as "Save $5,000 by the end of the year". Confirm and I\'ll save it, or tell me what to change.',
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "help me remember to drink water",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'I can set up a "Drink water" habit with a reasonable daytime default cadence. Confirm and I\'ll save it.',
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "help me remember to stretch during the day",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'I can set up a "Stretch" habit with daytime stretch-break defaults. Confirm and I\'ll save it.',
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "please remind me about my Invisalign on weekdays after lunch",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I can set up a weekday-after-lunch Invisalign habit. Confirm and I'll save it.",
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "recuérdame cepillarme los dientes por la mañana y por la noche",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Puedo guardar el hábito "Brush teeth" para la mañana y la noche. Confirma y lo guardo.',
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "help me brush my teeth at 8 am and 9 pm every day",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'I can set up a habit named "Brush teeth" for 8 am and 9 pm daily. Confirm and I\'ll save it.',
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Please remind me to shave twice a week.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'I can set up a "Shave" habit with a twice-weekly default cadence. Confirm and I\'ll save it.',
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "what life ops tasks are still left for today?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "You have 2 LifeOps tasks left for today: call mom and pay rent.",
          actions: ["LIFE"],
        },
      },
      {
        name: "{{name1}}",
        content: {
          text: "anything else in my life ops list i need to get done today?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "You have 1 LifeOps task left for today: pay rent.",
          actions: ["LIFE"],
        },
      },
    ],
  ],
};
