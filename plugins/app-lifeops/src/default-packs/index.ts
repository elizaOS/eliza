/**
 * Default-pack registration entry point (W1-D).
 *
 * The W1-A spine consumes `getAllDefaultPacks()` to seed records on first-run.
 * First-run customize consumes `getOfferedDefaultPacks()` to render the
 * pick-list. The lint script (`scripts/lint-default-packs.mjs`) consumes
 * `getAllDefaultPacks()` and runs `lintPacks()` against the result.
 *
 * Stub status: see `contract-stubs.ts` — all imported types are local Wave-1
 * stubs that match the frozen wave1-interfaces.md signatures. Once W1-A,
 * W1-C, W1-E, W1-F land, the stubs flip to re-exports from the owner
 * modules; consumers of this index do not change.
 */

export type {
  AnchorConsolidationPolicy,
  ConnectorContributionStub,
  ConnectorRegistryStub,
  DefaultEscalationLadderKey,
  EscalationLadder,
  EscalationStep,
  RecentTaskStatesProvider,
  RecentTaskStatesSummary,
  RelationshipFilterStub,
  RelationshipStateStub,
  RelationshipStoreStub,
  RelationshipStub,
  ScheduledTask,
  ScheduledTaskContextRequest,
  ScheduledTaskKind,
  ScheduledTaskRef,
  ScheduledTaskSeed,
  ScheduledTaskState,
  ScheduledTaskStatus,
  ScheduledTaskSubjectKind,
  ScheduledTaskTrigger,
  TerminalState,
} from "./contract-stubs.js";
export type { DefaultPack, DefaultPackRegistry } from "./registry-types.js";

import {
  DAILY_RHYTHM_PACK_KEY,
  DAILY_RHYTHM_RECORD_IDS,
  dailyRhythmPack,
} from "./daily-rhythm.js";
import {
  FOLLOWUP_STARTER_PACK_KEY,
  FOLLOWUP_STARTER_RECORD_IDS,
  buildFollowupTaskForRelationship,
  deriveOverdueFollowupTasks,
  followupStarterPack,
} from "./followup-starter.js";
import {
  HABIT_STARTER_KEYS,
  HABIT_STARTERS_PACK_KEY,
  HABIT_STARTER_RECORDS,
  buildSeedingOfferMessage,
  habitStartersPack,
} from "./habit-starters.js";
import {
  INBOX_TRIAGE_RECORD_IDS,
  INBOX_TRIAGE_REQUIRED_CAPABILITIES,
  INBOX_TRIAGE_STARTER_PACK_KEY,
  inboxTriageStarterPack,
  isInboxTriageEligible,
} from "./inbox-triage-starter.js";
import {
  MORNING_BRIEF_PACK_KEY,
  MORNING_BRIEF_RECORD_IDS,
  assembleMorningBrief,
  buildMorningBriefPromptFromReport,
  morningBriefPack,
} from "./morning-brief.js";
import {
  QUIET_THRESHOLD_DAYS,
  QUIET_USER_WATCHER_PACK_KEY,
  QUIET_USER_WATCHER_RECORD_IDS,
  type QuietUserWatcherObservation,
  deriveQuietObservations,
  quietUserWatcherPack,
  runQuietUserWatcher,
} from "./quiet-user-watcher.js";

import { DEFAULT_CONSOLIDATION_POLICIES } from "./consolidation-policies.js";
import { DEFAULT_ESCALATION_LADDERS } from "./escalation-ladders.js";
import {
  type PromptLintFinding,
  type PromptLintRuleKind,
  formatFindings,
  lintPack,
  lintPacks,
  lintPromptText,
} from "./lint.js";

import type { ConnectorRegistryStub } from "./contract-stubs.js";
import type { DefaultPack } from "./registry-types.js";

/**
 * The canonical list of W1-D default packs in the order they are offered.
 *
 * `plugin-health` (W1-B) registers its own packs (`bedtime`, `wake-up`,
 * `sleep-recap`) through the same registry — they do not appear here.
 */
export const DEFAULT_PACKS: ReadonlyArray<DefaultPack> = [
  dailyRhythmPack,
  morningBriefPack,
  quietUserWatcherPack,
  followupStarterPack,
  inboxTriageStarterPack,
  habitStartersPack,
];

export function getAllDefaultPacks(): DefaultPack[] {
  return [...DEFAULT_PACKS];
}

/**
 * Packs auto-seeded on the first-run defaults path. Capability-gated packs
 * (e.g. `inbox-triage-starter`) are filtered out when their capabilities
 * aren't registered.
 */
export function getDefaultEnabledPacks(options: {
  connectorRegistry?: ConnectorRegistryStub | null;
} = {}): DefaultPack[] {
  return DEFAULT_PACKS.filter((pack) => pack.defaultEnabled).filter((pack) => {
    if (!pack.requiredCapabilities || pack.requiredCapabilities.length === 0) {
      return true;
    }
    if (!options.connectorRegistry) return false;
    return pack.requiredCapabilities.every(
      (capability) =>
        options.connectorRegistry!.byCapability(capability).length > 0,
    );
  });
}

/**
 * Packs offered at first-run customize. All packs are offered; the user
 * picks. Capability-gated packs include a UI hint indicating they need a
 * connector.
 */
export function getOfferedDefaultPacks(): DefaultPack[] {
  return [...DEFAULT_PACKS];
}

/**
 * Find a pack by key.
 */
export function getDefaultPack(key: string): DefaultPack | null {
  return DEFAULT_PACKS.find((pack) => pack.key === key) ?? null;
}

// -- Re-exports for consumers --

export {
  DAILY_RHYTHM_PACK_KEY,
  DAILY_RHYTHM_RECORD_IDS,
  DEFAULT_CONSOLIDATION_POLICIES,
  DEFAULT_ESCALATION_LADDERS,
  FOLLOWUP_STARTER_PACK_KEY,
  FOLLOWUP_STARTER_RECORD_IDS,
  HABIT_STARTER_KEYS,
  HABIT_STARTERS_PACK_KEY,
  HABIT_STARTER_RECORDS,
  INBOX_TRIAGE_RECORD_IDS,
  INBOX_TRIAGE_REQUIRED_CAPABILITIES,
  INBOX_TRIAGE_STARTER_PACK_KEY,
  MORNING_BRIEF_PACK_KEY,
  MORNING_BRIEF_RECORD_IDS,
  QUIET_THRESHOLD_DAYS,
  QUIET_USER_WATCHER_PACK_KEY,
  QUIET_USER_WATCHER_RECORD_IDS,
  assembleMorningBrief,
  buildFollowupTaskForRelationship,
  buildMorningBriefPromptFromReport,
  buildSeedingOfferMessage,
  dailyRhythmPack,
  deriveOverdueFollowupTasks,
  deriveQuietObservations,
  followupStarterPack,
  formatFindings,
  habitStartersPack,
  inboxTriageStarterPack,
  isInboxTriageEligible,
  lintPack,
  lintPacks,
  lintPromptText,
  morningBriefPack,
  quietUserWatcherPack,
  runQuietUserWatcher,
};

export type { PromptLintFinding, PromptLintRuleKind, QuietUserWatcherObservation };
