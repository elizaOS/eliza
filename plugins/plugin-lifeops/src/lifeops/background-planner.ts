/**
 * WS5 — Background-job pipeline parity (PRD lines 418-433).
 *
 * Single shared LLM planner entry-point for every LifeOps background job.
 * Mirrors the chat planner pattern used in `actions/inbox.ts` (`resolveSubactionPlan`)
 * and `actions/life.ts`: structured JSON model output, no English keyword
 * routing, no regex, multilingual-safe.
 *
 * Every job calls `planJob({...})` to get a typed `{action, payload,
 * requiresApproval, reason}` decision. Sensitive actions
 * (requiresApproval=true) are then enqueued via the WS6 approval queue
 * (`approval-queue.types.ts`) instead of being executed directly.
 *
 * --------------------------------------------------------------------------
 * Background-job inventory (search results for brief|followup|reminder|
 * escalation|digest|watchdog|nudge|sweep|cron|schedule under
 * `eliza/plugins/app-lifeops/src/lifeops/` and adjacent job dirs).
 *
 * Real registered task workers (runtime.registerTaskWorker callsites):
 *
 *   1. LIFEOPS_SCHEDULER
 *      - file: lifeops/runtime.ts (registerLifeOpsTaskWorker)
 *      - exec: executeLifeOpsSchedulerTask -> service.processScheduledWork
 *      - downstream:
 *          a. service-mixin-reminders.ts processReminders         (PRD: meeting reminder ladder, draft aging sweeper)
 *          b. service-mixin-workflows.ts runDueWorkflows          (PRD: travel conflict detector, event asset sweeper)
 *          c. service-mixin-reminders.ts syncWebsiteAccessState   (enforcement window sweep)
 *
 *   2. PROACTIVE_AGENT
 *      - file: activity-profile/proactive-worker.ts (registerProactiveTaskWorker)
 *      - exec: executeProactiveTask
 *      - downstream:
 *          a. planGm                                              (PRD: daily brief builder — morning)
 *          b. planGn                                              (PRD: evening closeout)
 *          c. planNudges                                          (PRD: meeting reminder ladder)
 *          d. planDowntimeNudges                                  (PRD: pending-decision nudger / decision nudger)
 *          e. planGoalCheckIns                                    (PRD: relationship/goal overdue detector)
 *          f. planSeedingOffer                                    (onboarding seed)
 *          g. classifyCalendarEventsForProactivePlanning           (already LLM-routed)
 *
 *   3. FOLLOWUP_TRACKER_RECONCILE
 *      - file: followup/followup-tracker.ts (registerFollowupTrackerWorker)
 *      - exec: reconcileFollowupsOnce -> computeOverdueFollowups
 *      - downstream: writeOverdueDigestMemory                     (PRD: follow-up watchdog, relationship-overdue-detector)
 *
 *   4. WEBSITE_BLOCKER_UNBLOCK_TASK_NAME
 *      - file: website-blocker/service.ts                          (out of EA scope; kept for completeness)
 *
 *   5. BLOCK_RULE_RECONCILE_TASK_NAME
 *      - file: website-blocker/chat-integration/block-rule-reconciler.ts
 *
 * Other background entry points / sweeps that flow through the workers above:
 *
 *   - Activity profile rebuilds: activity-profile/service.ts       (driven by PROACTIVE_AGENT)
 *   - Reminder enforcement windows: lifeops/enforcement-windows.ts (driven by reminders mixin)
 *
 * Mapping to PRD §"Background Jobs And Cron Handlers" (lines 418-433):
 *
 *   PRD job                                  | Job key (this module)
 *   -----------------------------------------+--------------------------------
 *   Inbox ingest per connector               | inbox_ingest          (event-driven)
 *   Daily brief builder                      | daily_brief           (proactive_gm)
 *   Evening closeout                         | evening_closeout      (proactive_gn)
 *   Follow-up watchdog                       | followup_watchdog     (followup_tracker)
 *   Decision nudger                          | decision_nudger       (proactive downtime)
 *   Meeting reminder ladder                  | meeting_reminder      (proactive nudges + reminders)
 *   Travel conflict detector                 | travel_conflict       (workflows)
 *   Event asset sweeper                      | event_asset_sweep     (workflows)
 *   Draft aging sweeper                      | draft_aging_sweep     (reminders)
 *   Remote stuck-agent escalator             | remote_stuck_escalate (browser/computer-use)
 *   Pending-decision nudger                  | pending_decision      (proactive downtime)
 *   Missed-commitment repair                 | missed_commitment     (followup_tracker)
 *   Unsent-draft resurfacer                  | unsent_draft          (reminders)
 *   Relationship-overdue detector            | relationship_overdue  (followup_tracker)
 *   Deadline escalator                       | deadline_escalate     (reminders)
 *   Travel-ops rechecker                     | travel_ops            (workflows)
 *
 * --------------------------------------------------------------------------
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger, ModelType, runWithTrajectoryContext } from "@elizaos/core";
import { parseJsonModelRecord } from "../utils/json-model-output.js";
import type {
  ApprovalAction,
  ApprovalChannel,
  ApprovalPayload,
} from "./approval-queue.types.js";
import type { TravelBookingPayloadFields } from "./travel-booking.types.js";

// ---------------------------------------------------------------------------
// Job kinds — closed enum aligned to PRD §"Background Jobs And Cron Handlers"
// ---------------------------------------------------------------------------

/** Background-job kinds the planner knows about. Keep in sync with the
 *  inventory comment above. Adding a new kind requires updating the
 *  contract test (`background-job-parity.contract.test.ts`). */
export type BackgroundJobKind =
  | "inbox_ingest"
  | "daily_brief"
  | "evening_closeout"
  | "followup_watchdog"
  | "decision_nudger"
  | "meeting_reminder"
  | "travel_conflict"
  | "event_asset_sweep"
  | "draft_aging_sweep"
  | "remote_stuck_escalate"
  | "pending_decision"
  | "missed_commitment"
  | "unsent_draft"
  | "relationship_overdue"
  | "deadline_escalate"
  | "travel_ops";

/**
 * Result of `planJob`. `action` is null when the planner decided no action is
 * warranted right now (e.g. the GM window already fired). Callers MUST
 * inspect `requiresApproval` and route through the WS6 approval queue when
 * true — they MUST NOT execute sensitive actions directly.
 */
export interface TypedJobPlan {
  /** Closed-enum action selected by the planner, or null for noop. */
  readonly action: ApprovalAction | null;
  /** Action-specific payload. Null when `action` is null. */
  readonly payload: ApprovalPayload | null;
  /** When true, the caller MUST enqueue this in the approval queue
   *  (WS6) instead of executing directly. */
  readonly requiresApproval: boolean;
  /** Channel through which the action will be carried out. */
  readonly channel: ApprovalChannel;
  /** Human-readable justification from the planner. Always non-empty. */
  readonly reason: string;
}

/**
 * Context passed into the planner by a background job. Jobs assemble this
 * from their own runtime context (overdue digest, fired-actions log, etc.)
 * and let the LLM decide what to do.
 */
export interface BackgroundJobContext {
  readonly jobKind: BackgroundJobKind;
  readonly subjectUserId: string;
  /** Free-form structured snapshot of the job state (occurrences, calendar
   *  events, overdue contacts, ...). The planner reads this verbatim. */
  readonly snapshot: Readonly<Record<string, unknown>>;
  /** Channels enabled for this owner. Limits the planner's choices. */
  readonly availableChannels: ReadonlyArray<ApprovalChannel>;
  /** Reason the job ran — cron tick, event-driven trigger, etc. */
  readonly trigger: string;
}

const SENSITIVE_ACTIONS: ReadonlySet<ApprovalAction> = new Set<ApprovalAction>([
  "send_message",
  "send_email",
  "schedule_event",
  "modify_event",
  "cancel_event",
  "book_travel",
  "make_call",
  "execute_workflow",
  "spend_money",
]);

const ALL_ACTIONS: ReadonlyArray<ApprovalAction | "noop"> = [
  "send_message",
  "send_email",
  "schedule_event",
  "modify_event",
  "cancel_event",
  "book_travel",
  "make_call",
  "execute_workflow",
  "spend_money",
  "noop",
];

const ALL_CHANNELS: ReadonlyArray<ApprovalChannel> = [
  "telegram",
  "discord",
  "slack",
  "imessage",
  "sms",
  "x_dm",
  "email",
  "google_calendar",
  "browser",
  "phone",
  "internal",
];

/**
 * Error raised when the planner is unavailable or returned unparsable
 * output. We surface this loudly — the caller MUST decide whether to skip
 * this tick or escalate. We never silently fall back to a default action.
 */
export class BackgroundPlannerError extends Error {
  public readonly jobKind: BackgroundJobKind;
  public readonly cause?: unknown;

  constructor(jobKind: BackgroundJobKind, message: string, cause?: unknown) {
    super(`[BackgroundPlanner:${jobKind}] ${message}`);
    this.name = "BackgroundPlannerError";
    this.jobKind = jobKind;
    this.cause = cause;
  }
}

function isApprovalAction(value: unknown): value is ApprovalAction {
  return (
    typeof value === "string" && SENSITIVE_ACTIONS.has(value as ApprovalAction)
  );
}

function isApprovalChannel(value: unknown): value is ApprovalChannel {
  return (
    typeof value === "string" &&
    (ALL_CHANNELS as ReadonlyArray<string>).includes(value)
  );
}

function formatPromptValue(value: unknown, depth = 0): string {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (value === null) return "null";
  if (value === undefined) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)";
    return value
      .map((entry) => `${childIndent}- ${formatPromptValue(entry, depth + 1)}`)
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "(empty)";
    return entries
      .map(([key, entry]) => {
        const formatted = formatPromptValue(entry, depth + 1);
        return formatted.includes("\n")
          ? `${indent}${key}:\n${formatted}`
          : `${indent}${key}: ${formatted}`;
      })
      .join("\n");
  }
  return String(value);
}

function buildPrompt(jobContext: BackgroundJobContext): string {
  return [
    `Plan the BACKGROUND JOB action for job kind: ${jobContext.jobKind}.`,
    "You are routing a background tick for an executive assistant.",
    "Decide whether the assistant should take an action right now, and if so",
    "which action and through which channel. The assistant MUST NOT execute",
    "sensitive actions directly — anything that contacts a person, modifies a",
    "calendar, books travel, makes a call, runs a workflow, or spends money",
    "returns requiresApproval=true so the user can confirm.",
    "",
    "Return ONLY a JSON object with exactly these top-level fields:",
    `action: one of ${ALL_ACTIONS.join(", ")}`,
    `channel: one of ${ALL_CHANNELS.join(", ")}`,
    "requiresApproval: boolean",
    "reason: short justification",
    "payload: action-specific object, or null when action=noop",
    "",
    'Example noop: {"action":"noop","channel":"internal","requiresApproval":false,"reason":"Nothing is overdue on this tick.","payload":null}',
    "",
    'Example email: {"action":"send_email","channel":"email","requiresApproval":true,"reason":"The contact is overdue and email is the enabled channel.","payload":{"to":["person@example.com"],"subject":"Follow-up","body":"Short draft for user approval."}}',
    "",
    "Rules:",
    "- Choose action=noop when no action is warranted this tick (e.g. nothing overdue).",
    "- requiresApproval=true for any action that touches a person or external system.",
    "- requiresApproval=false ONLY when action=noop or the action is purely internal (logging, internal workflow with no side effects).",
    "- The reason must explain WHY this tick warrants the chosen action, in any language.",
    "",
    `Job trigger: ${jobContext.trigger}`,
    `Subject user: ${jobContext.subjectUserId}`,
    "Available channels:",
    formatPromptValue(jobContext.availableChannels),
    "Snapshot:",
    formatPromptValue(jobContext.snapshot),
  ].join("\n");
}

function emptyPayloadFor(_action: ApprovalAction): ApprovalPayload | null {
  // Sensitive payloads are required to be fully formed — we do not invent
  // recipients or amounts. If the planner returned a sensitive action with
  // no usable payload, the caller will see payload=null and skip the tick.
  return null;
}

function stringOrNull(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function coerceTravelSearch(
  value: unknown,
): TravelBookingPayloadFields["search"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const origin = stringOrNull(record, "origin");
  const destination = stringOrNull(record, "destination");
  const departureDate = stringOrNull(record, "departureDate");
  if (!origin || !destination || !departureDate) return null;
  const passengers =
    typeof record.passengers === "number" && Number.isFinite(record.passengers)
      ? Math.max(1, Math.floor(record.passengers))
      : undefined;
  return {
    origin,
    destination,
    departureDate,
    returnDate: stringOrNull(record, "returnDate") ?? undefined,
    passengers,
  };
}

function coerceTravelPassengers(
  value: unknown,
): TravelBookingPayloadFields["passengers"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const givenName = stringOrNull(record, "givenName");
    const familyName = stringOrNull(record, "familyName");
    const bornOn = stringOrNull(record, "bornOn");
    if (!givenName || !familyName || !bornOn) return [];
    return [
      {
        offerPassengerId: stringOrNull(record, "offerPassengerId"),
        givenName,
        familyName,
        bornOn,
        email: stringOrNull(record, "email"),
        phoneNumber: stringOrNull(record, "phoneNumber"),
        title: stringOrNull(record, "title"),
        gender: stringOrNull(record, "gender"),
      },
    ];
  });
}

function coerceTravelCalendarSync(
  value: unknown,
): TravelBookingPayloadFields["calendarSync"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    calendarId: stringOrNull(record, "calendarId"),
    title: stringOrNull(record, "title"),
    description: stringOrNull(record, "description"),
    location: stringOrNull(record, "location"),
    timeZone: stringOrNull(record, "timeZone"),
  };
}

function coercePayload(
  action: ApprovalAction,
  rawPayload: unknown,
): ApprovalPayload | null {
  if (
    !rawPayload ||
    typeof rawPayload !== "object" ||
    Array.isArray(rawPayload)
  ) {
    return emptyPayloadFor(action);
  }
  const record = rawPayload as Record<string, unknown>;

  switch (action) {
    case "send_message": {
      const recipient =
        typeof record.recipient === "string" ? record.recipient : null;
      const body = typeof record.body === "string" ? record.body : null;
      if (!recipient || !body) return null;
      return {
        action,
        recipient,
        body,
        replyToMessageId:
          typeof record.replyToMessageId === "string"
            ? record.replyToMessageId
            : null,
      };
    }
    case "send_email": {
      const subject =
        typeof record.subject === "string" ? record.subject : null;
      const body = typeof record.body === "string" ? record.body : null;
      const to = Array.isArray(record.to)
        ? record.to.filter((v): v is string => typeof v === "string")
        : [];
      if (!subject || !body || to.length === 0) return null;
      return {
        action,
        to,
        cc: Array.isArray(record.cc)
          ? record.cc.filter((v): v is string => typeof v === "string")
          : [],
        bcc: Array.isArray(record.bcc)
          ? record.bcc.filter((v): v is string => typeof v === "string")
          : [],
        subject,
        body,
        threadId: typeof record.threadId === "string" ? record.threadId : null,
      };
    }
    case "execute_workflow": {
      const workflowId =
        typeof record.workflowId === "string" ? record.workflowId : null;
      if (!workflowId) return null;
      const inputRaw = record.input;
      const input: Record<string, string | number | boolean> = {};
      if (
        inputRaw &&
        typeof inputRaw === "object" &&
        !Array.isArray(inputRaw)
      ) {
        for (const [k, v] of Object.entries(
          inputRaw as Record<string, unknown>,
        )) {
          if (
            typeof v === "string" ||
            typeof v === "number" ||
            typeof v === "boolean"
          ) {
            input[k] = v;
          }
        }
      }
      return { action, workflowId, input };
    }
    case "book_travel": {
      const provider =
        typeof record.provider === "string" ? record.provider : null;
      const itineraryRef =
        typeof record.itineraryRef === "string" ? record.itineraryRef : null;
      const totalCents =
        typeof record.totalCents === "number" &&
        Number.isFinite(record.totalCents)
          ? Math.round(record.totalCents)
          : null;
      const currency =
        typeof record.currency === "string" ? record.currency : null;
      const kind =
        record.kind === "flight" ||
        record.kind === "hotel" ||
        record.kind === "ground"
          ? record.kind
          : null;
      const search = coerceTravelSearch(record.search);
      const passengers = coerceTravelPassengers(record.passengers);
      const calendarSync = coerceTravelCalendarSync(record.calendarSync);
      if (
        !provider ||
        !itineraryRef ||
        totalCents === null ||
        !currency ||
        !kind
      ) {
        return null;
      }
      return {
        action,
        kind,
        provider,
        itineraryRef,
        totalCents,
        currency,
        offerId: typeof record.offerId === "string" ? record.offerId : null,
        offerRequestId:
          typeof record.offerRequestId === "string"
            ? record.offerRequestId
            : null,
        orderType:
          record.orderType === "hold" || record.orderType === "instant"
            ? record.orderType
            : null,
        search,
        passengers,
        calendarSync,
        summary: typeof record.summary === "string" ? record.summary : null,
      };
    }
    default:
      // For schedule/modify/cancel/book/call/spend the upstream caller has
      // not yet wired structured payload extraction. We surface null so the
      // caller can either request approval with a synthesized message or
      // skip this tick. We never fabricate recipients or amounts.
      return null;
  }
}

function parsePlannerOutput(raw: string): Record<string, unknown> | null {
  return parseJsonModelRecord<Record<string, unknown>>(raw);
}

function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) return true;
    if (["false", "no", "0"].includes(normalized)) return false;
  }
  return null;
}

/**
 * Plan a background-job action via the same LLM pipeline used by chat
 * actions. Returns a typed plan; throws `BackgroundPlannerError` on hard
 * planner failure (model unavailable, unparsable output). Callers MUST
 * route sensitive actions through the WS6 approval queue.
 */
export async function planJob(
  runtime: IAgentRuntime,
  jobContext: BackgroundJobContext,
): Promise<TypedJobPlan> {
  if (typeof runtime.useModel !== "function") {
    throw new BackgroundPlannerError(
      jobContext.jobKind,
      "runtime.useModel is unavailable; background job cannot run",
    );
  }

  const prompt = buildPrompt(jobContext);
  const result = await runWithTrajectoryContext(
    { purpose: "lifeops-background-planner" },
    () => runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
  );
  const raw = typeof result === "string" ? result : "";
  const parsed = parsePlannerOutput(raw);

  if (!parsed) {
    throw new BackgroundPlannerError(
      jobContext.jobKind,
      `planner returned unparsable output: ${raw.slice(0, 200)}`,
    );
  }

  const rawAction = parsed.action;
  const rawChannel = parsed.channel;
  const reason =
    typeof parsed.reason === "string" && parsed.reason.trim().length > 0
      ? parsed.reason.trim()
      : null;

  if (!reason) {
    throw new BackgroundPlannerError(
      jobContext.jobKind,
      "planner output missing required `reason` field",
    );
  }

  const channel: ApprovalChannel = isApprovalChannel(rawChannel)
    ? rawChannel
    : "internal";

  if (rawAction === "noop" || rawAction === null || rawAction === undefined) {
    logger.debug(`[BackgroundPlanner:${jobContext.jobKind}] noop — ${reason}`);
    return {
      action: null,
      payload: null,
      requiresApproval: false,
      channel,
      reason,
    };
  }

  if (!isApprovalAction(rawAction)) {
    throw new BackgroundPlannerError(
      jobContext.jobKind,
      `planner returned unknown action: ${String(rawAction)}`,
    );
  }

  const payload = coercePayload(rawAction, parsed.payload);
  const parsedRequiresApproval = coerceBoolean(parsed.requiresApproval);
  const requiresApproval =
    parsedRequiresApproval === false ? false : SENSITIVE_ACTIONS.has(rawAction);

  logger.info(
    `[BackgroundPlanner:${jobContext.jobKind}] action=${rawAction} channel=${channel} requiresApproval=${requiresApproval} — ${reason}`,
  );

  return {
    action: rawAction,
    payload,
    requiresApproval,
    channel,
    reason,
  };
}

/** Test-only helper: list all PRD job kinds the planner knows about. */
export const KNOWN_JOB_KINDS: ReadonlyArray<BackgroundJobKind> = [
  "inbox_ingest",
  "daily_brief",
  "evening_closeout",
  "followup_watchdog",
  "decision_nudger",
  "meeting_reminder",
  "travel_conflict",
  "event_asset_sweep",
  "draft_aging_sweep",
  "remote_stuck_escalate",
  "pending_decision",
  "missed_commitment",
  "unsent_draft",
  "relationship_overdue",
  "deadline_escalate",
  "travel_ops",
];
