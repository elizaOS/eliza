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
  approvalBatchReview: "default-pack:executive-assistant:approval-batch-review",
  privacyRedactionSweep:
    "default-pack:executive-assistant:privacy-redaction-sweep",
  interruptionFirebreak:
    "default-pack:executive-assistant:interruption-firebreak",
  statusCompression: "default-pack:executive-assistant:status-compression",
  vipEscalationSweep: "default-pack:executive-assistant:vip-escalation-sweep",
  delegationMapReview: "default-pack:executive-assistant:delegation-map-review",
  remoteAgentRecovery: "default-pack:executive-assistant:remote-agent-recovery",
  familyLogisticsPrep: "default-pack:executive-assistant:family-logistics-prep",
  outageRecoverySweep: "default-pack:executive-assistant:outage-recovery-sweep",
  weeklyOperatingReview:
    "default-pack:executive-assistant:weekly-operating-review",
  boardPackPrep: "default-pack:executive-assistant:board-pack-prep",
  chiefOfStaffHandoff:
    "default-pack:executive-assistant:chief-of-staff-handoff",
  eventPlanning: "default-pack:executive-assistant:event-planning",
  financeDisputeSweep: "default-pack:executive-assistant:finance-dispute-sweep",
  giftMilestonePrep: "default-pack:executive-assistant:gift-milestone-prep",
  hiringLoopCoordination:
    "default-pack:executive-assistant:hiring-loop-coordination",
  introRoutingSweep: "default-pack:executive-assistant:intro-routing-sweep",
  legalDeadlineSweep: "default-pack:executive-assistant:legal-deadline-sweep",
  travelDisruptionRecovery:
    "default-pack:executive-assistant:travel-disruption-recovery",
  vendorNegotiationPrep:
    "default-pack:executive-assistant:vendor-negotiation-prep",
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

const approvalBatchReview: RecapTaskDefinition = {
  ...base,
  definitionKind: "recap",
  promptInstructions:
    "Batch pending approvals into safe actions. Separate reversible drafts from irreversible actions, note risk and downstream effects, and ask for the smallest approval set.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 35 },
  },
  trigger: { kind: "cron", expression: "30 14 * * 1-5", tz: "owner_local" },
  priority: "high",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.approvalBatchReview,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "approval-batch-review",
    scenario: "assistant.approval_batch",
  },
};

const privacyRedactionSweep: WatcherTaskDefinition = {
  ...base,
  definitionKind: "watcher",
  promptInstructions:
    "Inspect outgoing summaries, delegated drafts, and briefing packets for credentials, financial account data, addresses, and sensitive personal context. Create approval tasks for unsafe shares.",
  contextRequest: {
    includeOwnerFacts: ["timezone"],
    includeRecentTaskStates: { limit: 20 },
  },
  trigger: { kind: "cron", expression: "0 12,17 * * 1-5", tz: "owner_local" },
  priority: "high",
  ownerVisible: false,
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.privacyRedactionSweep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "privacy-redaction-sweep",
    scenario: "assistant.privacy_redaction",
  },
};

const interruptionFirebreak: CheckInTaskDefinition = {
  ...base,
  definitionKind: "checkin",
  promptInstructions:
    "Protect the next focus block by triaging incoming items into wait, draft, delegate, or interrupt. Escalate only items that truly require owner attention now.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone", "workingHours"],
    includeRecentTaskStates: { limit: 25 },
  },
  trigger: { kind: "cron", expression: "0 9,13 * * 1-5", tz: "owner_local" },
  priority: "medium",
  completionCheck: {
    kind: "user_replied_within",
    params: { minutes: 120 },
    followupAfterMinutes: 120,
  },
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.interruptionFirebreak,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "interruption-firebreak",
    scenario: "assistant.interruption_firebreak",
  },
};

const statusCompression: RecapTaskDefinition = {
  ...base,
  definitionKind: "recap",
  promptInstructions:
    "Compress active project and assistant work into green, yellow, red, owner, next move, blocker, and decision needed. Use compact status indicators and avoid narrative unless asked.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 50 },
  },
  trigger: { kind: "cron", expression: "30 16 * * 1-5", tz: "owner_local" },
  priority: "medium",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.statusCompression,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "status-compression",
    scenario: "assistant.status_compression",
  },
};

const vipEscalationSweep: WatcherTaskDefinition = {
  ...base,
  definitionKind: "watcher",
  promptInstructions:
    "Scan VIP and high-trust relationship threads for decisions that may need a different channel. Choose DM, email, SMS, voice call, or wait based on urgency without reflexively interrupting.",
  contextRequest: {
    includeOwnerFacts: ["timezone"],
    includeRecentTaskStates: { limit: 25 },
  },
  trigger: { kind: "cron", expression: "0 9-18 * * 1-5", tz: "owner_local" },
  priority: "medium",
  ownerVisible: false,
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.vipEscalationSweep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "vip-escalation-sweep",
    scenario: "assistant.vip_escalation",
  },
};

const delegationMapReview: RecapTaskDefinition = {
  ...base,
  definitionKind: "recap",
  promptInstructions:
    "Map delegated work by owner, deadline, dependency, next check-in, and risk. Find unclear ownership and propose follow-ups without duplicating active tasks.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 50 },
  },
  trigger: { kind: "cron", expression: "0 15 * * 1,4", tz: "owner_local" },
  priority: "medium",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.delegationMapReview,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "delegation-map-review",
    scenario: "assistant.delegation_map",
  },
};

const remoteAgentRecovery: WatcherTaskDefinition = {
  ...base,
  definitionKind: "watcher",
  promptInstructions:
    "Review remote agent and assistant tasks for stuck states, missing inputs, failed handoffs, or stale status. Create the next safe recovery action with owner approval when needed.",
  contextRequest: {
    includeOwnerFacts: ["timezone"],
    includeRecentTaskStates: { limit: 50 },
  },
  trigger: {
    kind: "cron",
    expression: "0 10,14,18 * * 1-5",
    tz: "owner_local",
  },
  priority: "medium",
  ownerVisible: false,
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.remoteAgentRecovery,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "remote-agent-recovery",
    scenario: "assistant.remote_agent_stuck",
  },
};

const familyLogisticsPrep: ReminderTaskDefinition = {
  ...base,
  definitionKind: "reminder",
  promptInstructions:
    "Coordinate family logistics from schedules, pickups, appointments, errands, shared promises, and reminders. Ask only for owner decisions that unblock the plan.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 25 },
  },
  trigger: { kind: "cron", expression: "0 7 * * *", tz: "owner_local" },
  priority: "low",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.familyLogisticsPrep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "family-logistics-prep",
    scenario: "assistant.family_logistics",
  },
};

const outageRecoverySweep: WatcherTaskDefinition = {
  ...base,
  definitionKind: "watcher",
  promptInstructions:
    "After connector, service, or workflow outages, identify impacted commitments, missed messages, failed automations, stale approvals, and the repair order.",
  contextRequest: {
    includeOwnerFacts: ["timezone"],
    includeRecentTaskStates: { limit: 50 },
  },
  trigger: { kind: "cron", expression: "0 12 * * 1-5", tz: "owner_local" },
  priority: "medium",
  ownerVisible: false,
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.outageRecoverySweep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "outage-recovery-sweep",
    scenario: "assistant.outage_recovery",
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

const boardPackPrep: WatcherTaskDefinition = {
  ...base,
  definitionKind: "watcher",
  promptInstructions:
    "Prepare board pack gaps from documents, open approvals, missing metrics, calendar deadlines, and unresolved risks. Surface only missing inputs and owner decisions.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 50 },
  },
  trigger: { kind: "cron", expression: "0 11 * * 1,3", tz: "owner_local" },
  priority: "high",
  ownerVisible: false,
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.boardPackPrep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "board-pack-prep",
    scenario: "assistant.board_pack_prep",
  },
};

const chiefOfStaffHandoff: RecapTaskDefinition = {
  ...base,
  definitionKind: "recap",
  promptInstructions:
    "Build a chief-of-staff handoff with weekly priorities, delegated owners, blocked decisions, relationship follow-ups, and status risks. Keep it terse and owner-actionable.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 50 },
  },
  trigger: { kind: "cron", expression: "0 16 * * 4", tz: "owner_local" },
  priority: "medium",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.chiefOfStaffHandoff,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "chief-of-staff-handoff",
    scenario: "assistant.chief_of_staff_handoff",
  },
};

const eventPlanning: WatcherTaskDefinition = {
  ...base,
  definitionKind: "watcher",
  promptInstructions:
    "Coordinate event planning gaps across calendar holds, invite list, venue confirmation, menu or prep documents, travel buffers, and delegated follow-ups.",
  contextRequest: {
    includeOwnerFacts: ["timezone"],
    includeRecentTaskStates: { limit: 35 },
  },
  trigger: { kind: "cron", expression: "0 10 * * 2,5", tz: "owner_local" },
  priority: "medium",
  ownerVisible: false,
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.eventPlanning,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "event-planning",
    scenario: "assistant.event_planning",
  },
};

const financeDisputeSweep: CheckInTaskDefinition = {
  ...base,
  definitionKind: "checkin",
  promptInstructions:
    "Find finance disputes that need evidence or owner approval. Collect receipts, payment records, related messages, approval owner, and a safe next-action draft.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 35 },
  },
  trigger: { kind: "cron", expression: "30 11 * * 1-5", tz: "owner_local" },
  priority: "medium",
  completionCheck: {
    kind: "user_replied_within",
    params: { minutes: 240 },
    followupAfterMinutes: 240,
  },
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.financeDisputeSweep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "finance-dispute-sweep",
    scenario: "assistant.finance_dispute",
  },
};

const giftMilestonePrep: ReminderTaskDefinition = {
  ...base,
  definitionKind: "reminder",
  promptInstructions:
    "Prepare relationship milestone gifts from calendar dates, preferences in messages, budget notes, delivery deadlines, and explicit owner approval before purchase.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 20 },
  },
  trigger: { kind: "cron", expression: "0 8 * * 2", tz: "owner_local" },
  priority: "low",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.giftMilestonePrep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "gift-milestone-prep",
    scenario: "assistant.gift_milestone",
  },
};

const hiringLoopCoordination: WatcherTaskDefinition = {
  ...base,
  definitionKind: "watcher",
  promptInstructions:
    "Coordinate hiring loop gaps: interview calendar, candidate documents, panel owner reminders, scorecard deadline, and follow-up messages.",
  contextRequest: {
    includeOwnerFacts: ["timezone"],
    includeRecentTaskStates: { limit: 30 },
  },
  trigger: { kind: "cron", expression: "0 12 * * 1-5", tz: "owner_local" },
  priority: "medium",
  ownerVisible: false,
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.hiringLoopCoordination,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "hiring-loop-coordination",
    scenario: "assistant.hiring_loop",
  },
};

const introRoutingSweep: RecapTaskDefinition = {
  ...base,
  definitionKind: "recap",
  promptInstructions:
    "Triage inbound intro requests into accept, delegate, decline, or schedule. Use relationship context and create approval-ready reply drafts.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 30 },
  },
  trigger: { kind: "cron", expression: "30 10,15 * * 1-5", tz: "owner_local" },
  priority: "medium",
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.introRoutingSweep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "intro-routing-sweep",
    scenario: "assistant.intro_routing",
  },
};

const legalDeadlineSweep: WatcherTaskDefinition = {
  ...base,
  definitionKind: "watcher",
  promptInstructions:
    "Track legal document deadlines across signature documents, counsel messages, calendar cutoff, missing approvals, and safe follow-up drafts.",
  contextRequest: {
    includeOwnerFacts: ["timezone"],
    includeRecentTaskStates: { limit: 30 },
  },
  trigger: { kind: "cron", expression: "0 9 * * 1-5", tz: "owner_local" },
  priority: "high",
  ownerVisible: false,
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.legalDeadlineSweep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "legal-deadline-sweep",
    scenario: "assistant.legal_deadline",
  },
};

const travelDisruptionRecovery: WatcherTaskDefinition = {
  ...base,
  definitionKind: "watcher",
  promptInstructions:
    "Recover from travel disruptions by reworking itinerary, calendar conflicts, hotel and ground transport, people notifications, receipts, and approval decisions.",
  contextRequest: {
    includeOwnerFacts: ["timezone", "homeAirport"],
    includeRecentTaskStates: { limit: 35 },
  },
  trigger: { kind: "cron", expression: "0 7-21 * * *", tz: "owner_local" },
  priority: "high",
  ownerVisible: false,
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.travelDisruptionRecovery,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "travel-disruption-recovery",
    scenario: "assistant.travel_disruption",
  },
};

const vendorNegotiationPrep: CheckInTaskDefinition = {
  ...base,
  definitionKind: "checkin",
  promptInstructions:
    "Prepare vendor renewal negotiation context: contract documents, current spend, cancellation deadline, prior messages, approval owner, and concise reply draft.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "timezone"],
    includeRecentTaskStates: { limit: 35 },
  },
  trigger: { kind: "cron", expression: "0 13 * * 2", tz: "owner_local" },
  priority: "medium",
  completionCheck: {
    kind: "user_replied_within",
    params: { minutes: 240 },
    followupAfterMinutes: 240,
  },
  idempotencyKey: EXECUTIVE_ASSISTANT_RECORD_IDS.vendorNegotiationPrep,
  metadata: {
    packKey: EXECUTIVE_ASSISTANT_PACK_KEY,
    recordKey: "vendor-negotiation-prep",
    scenario: "assistant.vendor_negotiation",
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
  approvalBatchReview,
  privacyRedactionSweep,
  interruptionFirebreak,
  statusCompression,
  vipEscalationSweep,
  delegationMapReview,
  remoteAgentRecovery,
  familyLogisticsPrep,
  outageRecoverySweep,
  weeklyOperatingReview,
  boardPackPrep,
  chiefOfStaffHandoff,
  eventPlanning,
  financeDisputeSweep,
  giftMilestonePrep,
  hiringLoopCoordination,
  introRoutingSweep,
  legalDeadlineSweep,
  travelDisruptionRecovery,
  vendorNegotiationPrep,
  monthlyAdminReview,
  homeOpsSweep,
];

export const executiveAssistantPack: DefaultPack = {
  key: EXECUTIVE_ASSISTANT_PACK_KEY,
  label: "Executive assistant",
  description:
    "Opt-in personal assistant scenario pack for command briefs, meeting prep, calendar conflicts, inbox decisions, waiting-on loops, delegation, decision logs, approvals, privacy checks, focus protection, status compression, VIP escalation, travel readiness, disruptions, expenses, disputes, renewals, people cadence, intro routing, event planning, board packs, legal deadlines, vendor negotiation, hiring loops, gifts, document signatures, closeout, weekly operating review, chief-of-staff handoff, remote recovery, family logistics, monthly admin, and home operations.",
  defaultEnabled: false,
  requiredCapabilities: [],
  records: compileTaskDefinitions(definitions),
  uiHints: {
    summaryOnDayOne:
      "Adds a broad assistant operating loop. Best after calendar, inbox, documents, and payment connectors are configured.",
    expectedFireCountPerDay: 12,
  },
};
