/**
 * Default pack: `executive-assistant`.
 *
 * Opt-in scenario expansion for LifeOps as a personal / executive assistant.
 * The records stay LifeOps-owned: calendar, inbox, decisions, delegation,
 * travel, money admin, relationship cadence, and owner-facing planning. Health
 * and screen-time scenarios remain in `@elizaos/plugin-health`.
 */

import type { DefaultPack } from "./registry-types.js";
import {
  compileTaskDefinitions,
  type CheckInTaskDefinition,
  type RecapTaskDefinition,
  type ReminderTaskDefinition,
  type TaskDefinition,
  type WatcherTaskDefinition,
} from "./task-definitions.js";

export const EXECUTIVE_ASSISTANT_PACK_KEY = "executive-assistant";

export const EXECUTIVE_ASSISTANT_RECORD_IDS = {
  dailyCommandBrief: "default-pack:executive-assistant:daily-command-brief",
  meetingPrep: "default-pack:executive-assistant:meeting-prep",
  calendarConflictSweep:
    "default-pack:executive-assistant:calendar-conflict-sweep",
  inboxDecisions: "default-pack:executive-assistant:inbox-decisions",
  waitingOnWatcher: "default-pack:executive-assistant:waiting-on-watcher",
  delegationReview: "default-pack:executive-assistant:delegation-review",
  decisionLogCapture: "default-pack:executive-assistant:decision-log-capture",
  travelReadiness: "default-pack:executive-assistant:travel-readiness",
  expenseSweep: "default-pack:executive-assistant:expense-sweep",
  renewalSweep: "default-pack:executive-assistant:renewal-sweep",
  peopleCadencePrep: "default-pack:executive-assistant:people-cadence-prep",
  documentSignatureSweep:
    "default-pack:executive-assistant:document-signature-sweep",
  endOfDayCloseout: "default-pack:executive-assistant:end-of-day-closeout",
  weeklyOperatingReview:
    "default-pack:executive-assistant:weekly-operating-review",
  monthlyAdminReview: "default-pack:executive-assistant:monthly-admin-review",
  homeOpsSweep: "default-pack:executive-assistant:home-ops-sweep",
} as const;

const base = {
  respectsGlobalPause: true,
  source: "default_pack" as const,
  createdBy: EXECUTIVE_ASSISTANT_PACK_KEY,
  ownerVisible: true,
};

const dailyCommandBrief: RecapTaskDefinition = {
  ...base,
  definitionKind: "recap",
  promptInstructions:
    "Assemble a command brief from calendar, inbox, pending prompts, overdue tasks, relationship follow-ups, documents awaiting action, travel holds, and money admin. Use icons or compact labels in the owner surface. Keep prose minimal and ask for one decision at a time.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone", "morningWindow"],
    includeRecentTaskStates: { limit: 20 },
  },
  trigger: {
    kind: "relative_to_anchor",
    anchorKey: "wake.confirmed",
    offsetMinutes: 10,
  },
  priority: "high",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.dailyCommandBrief,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "daily-command-brief",
    scenario: "assistant.command_brief",
  },
};

const meetingPrep: ReminderTaskDefinition = {
  ...base,
  definitionKind: "reminder",
  promptInstructions:
    "Prepare the next working block: scan upcoming calendar events, related threads, docs, blockers, and people context. Surface missing agenda, location, dial-in, prep document, decision owner, and likely follow-up. Keep the owner-facing result compact.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 10 },
  },
  trigger: { kind: "cron", expression: "*/30 7-19 * * 1-5", tz: "owner_local" },
  priority: "medium",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.meetingPrep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "meeting-prep",
    scenario: "assistant.meeting_prep",
  },
};

const calendarConflictSweep: WatcherTaskDefinition = {
  ...base,
  definitionKind: "watcher",
  promptInstructions:
    "Scan calendar for overlaps, missing travel buffers, missing locations, no-agenda meetings, and unaccepted priority events. Create owner-visible approval or reminder tasks for conflicts that need a decision. Do not message external people directly.",
  contextRequest: {
    includeOwnerFacts: ["timezone", "workingHours"],
  },
  trigger: { kind: "cron", expression: "0 6,12,17 * * 1-5", tz: "owner_local" },
  priority: "medium",
  ownerVisible: false,
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.calendarConflictSweep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "calendar-conflict-sweep",
    scenario: "assistant.calendar_conflicts",
  },
};

const inboxDecisions: RecapTaskDefinition = {
  ...base,
  definitionKind: "recap",
  promptInstructions:
    "Find inbox items that require a decision, approval, scheduling answer, payment answer, or delegated reply. Group by required action, not by sender. Present only the smallest useful batch and create pending prompts for unresolved decisions.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 15 },
  },
  trigger: { kind: "cron", expression: "0 10,15 * * 1-5", tz: "owner_local" },
  priority: "high",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.inboxDecisions,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "inbox-decisions",
    scenario: "assistant.inbox_decisions",
  },
};

const waitingOnWatcher: WatcherTaskDefinition = {
  ...base,
  definitionKind: "watcher",
  promptInstructions:
    "Scan delegated items, sent questions, shared docs, and open approvals for waiting-on states. Create follow-up tasks with subject.kind='thread' or subject.kind='relationship' using stable IDs from context. Avoid duplicate nudges already represented by an active task.",
  contextRequest: {
    includeOwnerFacts: ["timezone"],
    includeRecentTaskStates: { limit: 30 },
  },
  trigger: { kind: "cron", expression: "0 11 * * 1-5", tz: "owner_local" },
  priority: "medium",
  ownerVisible: false,
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.waitingOnWatcher,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "waiting-on-watcher",
    scenario: "assistant.waiting_on",
  },
};

const delegationReview: CheckInTaskDefinition = {
  ...base,
  definitionKind: "checkin",
  promptInstructions:
    "Ask for a fast delegation pass over active projects and open loops. Convert owner replies into assignments, follow-ups, or reminders through ScheduledTask records. Keep the prompt short and focused on one unresolved owner decision.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 25 },
  },
  trigger: { kind: "cron", expression: "0 16 * * 1-5", tz: "owner_local" },
  priority: "medium",
  completionCheck: {
    kind: "user_replied_within",
    params: { minutes: 240 },
    followupAfterMinutes: 240,
  },
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.delegationReview,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "delegation-review",
    scenario: "assistant.delegation",
  },
};

const decisionLogCapture: RecapTaskDefinition = {
  ...base,
  definitionKind: "recap",
  promptInstructions:
    "Capture decisions from recent chats, approvals, meetings, and documents. Store concise decision records with owner, date, source thread or document, rationale, and follow-up task references. Surface only ambiguous decisions needing confirmation.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 20 },
  },
  trigger: { kind: "cron", expression: "30 17 * * 1-5", tz: "owner_local" },
  priority: "medium",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.decisionLogCapture,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "decision-log-capture",
    scenario: "assistant.decision_log",
  },
};

const travelReadiness: WatcherTaskDefinition = {
  ...base,
  definitionKind: "watcher",
  promptInstructions:
    "Scan upcoming travel for booking holds, confirmation numbers, passport or ID notes, calendar gaps, airport transfer gaps, lodging gaps, weather-sensitive reminders, and expense capture. Create reminders or approval tasks for missing items.",
  contextRequest: {
    includeOwnerFacts: ["timezone", "homeAirport"],
    includeRecentTaskStates: { limit: 20 },
  },
  trigger: { kind: "cron", expression: "0 13 * * *", tz: "owner_local" },
  priority: "medium",
  ownerVisible: false,
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.travelReadiness,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "travel-readiness",
    scenario: "assistant.travel_readiness",
  },
};

const expenseSweep: RecapTaskDefinition = {
  ...base,
  definitionKind: "recap",
  promptInstructions:
    "Collect likely reimbursable expenses from receipts, payments, calendar travel, and inbox confirmations. Group by trip or project and request only missing classification details. Keep the owner surface visual and terse.",
  contextRequest: {
    includeOwnerFacts: ["timezone"],
    includeRecentTaskStates: { limit: 20 },
  },
  trigger: { kind: "cron", expression: "0 18 * * 5", tz: "owner_local" },
  priority: "low",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.expenseSweep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "expense-sweep",
    scenario: "assistant.expenses",
  },
};

const renewalSweep: ReminderTaskDefinition = {
  ...base,
  definitionKind: "reminder",
  promptInstructions:
    "Review subscriptions, trials, renewals, warranties, insurance dates, and recurring charges. Surface near-term actions with amount, renewal date, owner decision needed, and cancel or keep options. Avoid low-confidence guesses.",
  contextRequest: {
    includeOwnerFacts: ["timezone"],
    includeRecentTaskStates: { limit: 20 },
  },
  trigger: { kind: "cron", expression: "0 9 * * 1", tz: "owner_local" },
  priority: "medium",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.renewalSweep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "renewal-sweep",
    scenario: "assistant.renewals",
  },
};

const peopleCadencePrep: RecapTaskDefinition = {
  ...base,
  definitionKind: "recap",
  promptInstructions:
    "Prepare relationship touchpoints from overdue cadence edges, upcoming birthdays or milestones, recent promises, shared threads, and open asks. Use EntityStore names and relationship context only. Keep suggestions brief and action-oriented.",
  contextRequest: {
    includeOwnerFacts: ["timezone"],
    includeRecentTaskStates: { limit: 20 },
  },
  trigger: { kind: "cron", expression: "0 8 * * 1", tz: "owner_local" },
  priority: "medium",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.peopleCadencePrep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "people-cadence-prep",
    scenario: "assistant.people_cadence",
  },
};

const documentSignatureSweep: WatcherTaskDefinition = {
  ...base,
  definitionKind: "watcher",
  promptInstructions:
    "Scan documents, approval requests, and inbox attachments for signature, review, redline, notarization, or upload tasks. Create owner-visible approval tasks for items that need explicit approval before sending.",
  contextRequest: {
    includeOwnerFacts: ["timezone"],
    includeRecentTaskStates: { limit: 20 },
  },
  trigger: { kind: "cron", expression: "0 14 * * 1-5", tz: "owner_local" },
  priority: "medium",
  ownerVisible: false,
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.documentSignatureSweep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "document-signature-sweep",
    scenario: "assistant.document_signatures",
  },
};

const endOfDayCloseout: CheckInTaskDefinition = {
  ...base,
  definitionKind: "checkin",
  promptInstructions:
    "Run a closeout: show unresolved decisions, tomorrow risks, waiting-on items, promises made today, and tasks worth moving. Ask for one compact confirmation batch and write updates into ScheduledTask records.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone", "eveningWindow"],
    includeRecentTaskStates: { limit: 30 },
  },
  trigger: { kind: "cron", expression: "0 18 * * 1-5", tz: "owner_local" },
  priority: "high",
  completionCheck: {
    kind: "user_replied_within",
    params: { minutes: 180 },
    followupAfterMinutes: 180,
  },
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.endOfDayCloseout,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "end-of-day-closeout",
    scenario: "assistant.closeout",
  },
};

const weeklyOperatingReview: RecapTaskDefinition = {
  ...base,
  definitionKind: "recap",
  promptInstructions:
    "Assemble a weekly operating review across goals, projects, calendar load, delegated work, inbox debt, money admin, travel, relationships, and pending approvals. Use compact status indicators and convert each owner decision into a task.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 50 },
  },
  trigger: { kind: "cron", expression: "0 15 * * 5", tz: "owner_local" },
  priority: "high",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.weeklyOperatingReview,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "weekly-operating-review",
    scenario: "assistant.weekly_review",
  },
};

const monthlyAdminReview: RecapTaskDefinition = {
  ...base,
  definitionKind: "recap",
  promptInstructions:
    "Prepare a monthly admin review: recurring charges, documents, renewals, taxes, warranties, household tasks, insurance, travel credits, and stale approvals. Surface the smallest set of decisions that unlocks progress.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 50 },
  },
  trigger: { kind: "cron", expression: "0 10 1 * *", tz: "owner_local" },
  priority: "medium",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.monthlyAdminReview,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "monthly-admin-review",
    scenario: "assistant.monthly_admin",
  },
};

const homeOpsSweep: ReminderTaskDefinition = {
  ...base,
  definitionKind: "reminder",
  promptInstructions:
    "Review household and personal operations: deliveries, maintenance, errands, appointments, documents, reservations, gifts, and support tickets. Create reminders or pending prompts for owner decisions only.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 20 },
  },
  trigger: { kind: "cron", expression: "0 9 * * 6", tz: "owner_local" },
  priority: "low",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.homeOpsSweep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "home-ops-sweep",
    scenario: "assistant.home_ops",
  },
};

const definitions: ReadonlyArray<TaskDefinition> = [
  dailyCommandBrief,
  meetingPrep,
  calendarConflictSweep,
  inboxDecisions,
  waitingOnWatcher,
  delegationReview,
  decisionLogCapture,
  travelReadiness,
  expenseSweep,
  renewalSweep,
  peopleCadencePrep,
  documentSignatureSweep,
  endOfDayCloseout,
  weeklyOperatingReview,
  monthlyAdminReview,
  homeOpsSweep,
];

export const executiveAssistantPack: DefaultPack = {
  key: EXECUTIVE_ASSISTANT_PACK_KEY,
  label: "Executive assistant",
  description:
    "Opt-in personal assistant scenario pack for command briefs, meeting prep, calendar conflicts, inbox decisions, waiting-on loops, delegation, decision logs, travel readiness, expenses, renewals, people cadence, document signatures, closeout, weekly operating review, monthly admin, and home operations.",
  defaultEnabled: false,
  requiredCapabilities: [],
  records: compileTaskDefinitions(definitions),
  uiHints: {
    summaryOnDayOne:
      "Adds a broad assistant operating loop. Best after calendar, inbox, documents, and payment connectors are configured.",
    expectedFireCountPerDay: 6,
  },
};
