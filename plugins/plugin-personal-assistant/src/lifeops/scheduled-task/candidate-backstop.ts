/**
 * Candidate-action backstop rule for LifeOps scheduled-task actions.
 *
 * The core message pipeline runs a coding-delegation backstop that, when a
 * message reads as coding work, can strip candidate actions in favor of a
 * coding-delegation action. LifeOps' scheduled-task admin actions
 * (`SCHEDULED_TASKS*`) share verbs ("create", "make", "update") with coding
 * requests, so without a rule a genuine "remind me tomorrow" turn whose
 * candidate set included a scheduled-task action could be hijacked into a
 * coding delegation.
 *
 * This rule declares LifeOps' scheduled-task action names plus a natural-
 * language matcher so the pipeline protects those candidates on real
 * scheduled-task turns and only strips them when the message is not one. It is
 * registered into core via `registerCandidateActionBackstopRule` at plugin
 * init — core no longer hardcodes these names or the heuristic.
 */

import type { CandidateActionBackstopRule } from "@elizaos/core";

/**
 * Canonical scheduled-task candidate action names the planner may emit for the
 * `SCHEDULED_TASKS` umbrella action. Matched case/underscore-insensitively by
 * the pipeline's action-identifier normalization.
 */
const SCHEDULED_TASK_ACTION_NAMES: readonly string[] = [
  "SCHEDULED_TASKS",
  "SCHEDULED_TASKS_ACKNOWLEDGE",
  "SCHEDULED_TASKS_CANCEL",
  "SCHEDULED_TASKS_COMPLETE",
  "SCHEDULED_TASKS_CREATE",
  "SCHEDULED_TASKS_DISMISS",
  "SCHEDULED_TASKS_GET",
  "SCHEDULED_TASKS_HISTORY",
  "SCHEDULED_TASKS_LIST",
  "SCHEDULED_TASKS_REOPEN",
  "SCHEDULED_TASKS_SKIP",
  "SCHEDULED_TASKS_SNOOZE",
  "SCHEDULED_TASKS_UPDATE",
  // Owner recurring-commitment surfaces. Habit/routine phrasing ("25 pushups,
  // 3 times a day") is a scheduled-item mutation, and the fabricated-claim
  // recovery path resolves its candidates from this list — without these
  // names a fake "I've scheduled your pushups" reply had no owner-routine
  // recovery target (#17028).
  "OWNER_ROUTINES",
  "OWNER_REMINDERS",
  // Owner todo reads/writes: the matcher already covers "todo" phrasing, and
  // the recovery path needs the reader as a target so a failed VIEWS detour
  // on "list my personal todos" can retry the tier-A owner surface instead of
  // finishing on the failure (read-side of fead478cfa).
  "OWNER_TODOS",
];

/**
 * True when `text` is genuinely a scheduled-task / reminder request. Mirrors the
 * heuristic previously hardcoded in core's message service.
 */
export function looksLikeScheduledTaskRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) {
    return false;
  }
  return (
    /\b(?:remind\s+me|reminder|scheduled?\s+task|scheduled\s+item|lifeops|todo|to[- ]?do|snooze|recap|check[- ]?in|follow[- ]?up|watcher|approval)\b/iu.test(
      normalized,
    ) ||
    /\b(?:schedule|create|make|add|set\s+up|track)\b[\s\S]{0,80}\b(?:task|reminder|todo|to[- ]?do|check[- ]?in|follow[- ]?up|watcher|recap|approval|habit|routine)\b/iu.test(
      normalized,
    ) ||
    // First-person past tense covers fabricated side-effect claims ("I've
    // scheduled your pushups"), which are matched against REPLY text to pick
    // recovery candidates. A bare "scheduled" is intentionally insufficient:
    // status reports and coding asks commonly discuss scheduled work (#17028).
    /\b(?:i|we)(?:['’]ve| have)\s+scheduled\b/iu.test(normalized) ||
    // Recurring cadence phrasing is a scheduled-item commitment even without
    // an explicit task/reminder noun ("25 pushups, 3 times a day").
    /\b\d+\s+times?\s+(?:a|per|each|every)\s+(?:day|week|month)\b/iu.test(
      normalized,
    ) ||
    /\b(?:tomorrow|tonight|later|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|every\s+(?:day|week|month|morning|evening))\b/iu.test(
      normalized,
    )
  );
}

export function createScheduledTaskCandidateBackstopRule(): CandidateActionBackstopRule {
  return {
    actionNames: SCHEDULED_TASK_ACTION_NAMES,
    matches: looksLikeScheduledTaskRequest,
  };
}
