/**
 * Elderly week-1 loop — the quiet-user watcher, proven structurally end to end.
 *
 * When the elderly owner goes quiet for days — three morning check-ins in a row
 * fire and expire unanswered — the quiet-user watcher must notice and the
 * assistant must BACK OFF, not chase her harder. This drives the REAL
 * ScheduledTask spine: three check-ins are created through REST and driven to
 * `fired` → terminal `expired` through logical-clock ticks, so the production
 * recent-task-states log lays down the genuine `checkin/expired` streak the
 * watcher reads (`deriveQuietObservations` / `quietStreakDaysFromObservations`,
 * threshold 3). The fourth-day check-in then times out and the watcher's
 * structural consumer (#12284 item 8) softens its no-reply ladder one notch
 * (normal → minimal): the retry ladder is emptied and the decision is stamped
 * `quietStreakSoftened` with `quietStreakDays >= 3` — read back off the
 * persisted task, not inferred from behavior.
 *
 * NOT a crisis guard: a quiet week is ordinary, non-judgmental low engagement;
 * this asserts a gentler cadence, never a 988/emergency effect (#12780
 * not-planned).
 *
 * Keyless-runnable under the deterministic proxy; `live-only` lane for the same
 * develop-side strict dispatch-render gap the sibling elderly-week1 scenarios
 * document.
 *
 * Fail-without-fix anchor: revert `softenReminderIntensityForQuietStreak` /
 * `resolveQuietStreakDays` in `scheduler.ts` so the streak no longer steps the
 * ladder down, and the `quietStreakSoftened` / emptied-ladder assertions fail.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
  captureTaskId,
  findTask,
  futureUtc,
  isRecord,
  readTick,
} from "./_helpers/elderly-week1";

const SCENARIO_ID = "elderly-week1-quiet-user-watcher-escalates";
const DELIVERY = "scenario_elderly_quiet_delivery";

// Three ignored check-ins on consecutive mornings, then a fourth-day check-in
// that times out. All within the watcher's 7-day lookback so the streak counts.
const CHECKIN_FIRE = [
  futureUtc(8, 0, 2),
  futureUtc(8, 0, 3),
  futureUtc(8, 0, 4),
];
const CHECKIN_EXPIRE = CHECKIN_FIRE.map(
  (fire) => new Date(fire.getTime() + 61 * 60_000),
);
const FOURTH_FIRE = futureUtc(8, 0, 5);
const FOURTH_TIMEOUT = new Date(FOURTH_FIRE.getTime() + 61 * 60_000);

const ledger: unknown[] = [];
const fourth = { id: null as string | null };

/**
 * An unanswered morning check-in that expires on the first timeout (no retry)
 * so three of them lay down a length-3 `checkin/expired` streak quickly.
 */
function streakCheckinBody(dayIndex: number): Record<string, unknown> {
  return {
    kind: "checkin",
    promptInstructions: "Good morning — just checking in, how are you today?",
    trigger: { kind: "once", atIso: CHECKIN_FIRE[dayIndex]?.toISOString() },
    priority: "medium",
    completionCheck: {
      kind: "user_replied_within",
      followupAfterMinutes: 60,
      params: { lookbackMinutes: 60 },
    },
    output: { destination: "channel", target: `${DELIVERY}:owner` },
    respectsGlobalPause: false,
    source: "default_pack",
    createdBy: SCENARIO_ID,
    ownerVisible: true,
    idempotencyKey: `${SCENARIO_ID}-checkin-${dayIndex}`,
    metadata: {
      scenario: SCENARIO_ID,
      noReplyPolicy: {
        maxRetries: 0,
        terminalStatus: "expired",
        terminalReason: "no_reply_checkin_expired",
      },
    },
  };
}

function createStreakCheckin(dayIndex: number) {
  return {
    kind: "api" as const,
    name: `seed ignored check-in ${dayIndex + 1}`,
    method: "POST" as const,
    path: "/api/lifeops/scheduled-tasks",
    body: streakCheckinBody(dayIndex),
    expectedStatus: 201,
  };
}

function fireStreakCheckin(dayIndex: number) {
  return {
    kind: "tick" as const,
    name: `morning ${dayIndex + 1}: check-in fires`,
    worker: "lifeops_scheduler" as const,
    options: {
      now: CHECKIN_FIRE[dayIndex]?.toISOString(),
      scheduledTaskLimit: 50,
    },
  };
}

function expireStreakCheckin(dayIndex: number) {
  return {
    kind: "tick" as const,
    name: `morning ${dayIndex + 1}: unanswered check-in expires`,
    worker: "lifeops_scheduler" as const,
    options: {
      now: CHECKIN_EXPIRE[dayIndex]?.toISOString(),
      scheduledTaskLimit: 50,
    },
  };
}

/** The fourth-day timeout must settle terminally under the softened ladder. */
function assertFourthSoftenedTerminal(
  _status: number,
  body: unknown,
): string | undefined {
  const tick = readTick(body, fourth.id);
  if (typeof tick === "string") return tick;
  if (tick.timeouts.length !== 1) {
    return `expected one completion timeout for the fourth check-in, saw ${JSON.stringify(tick.timeouts)}`;
  }
  const entry = tick.timeouts[0];
  if (entry?.status !== "expired") {
    return `expected the softened check-in to settle terminally (expired), saw ${entry?.status}`;
  }
  if (entry.reason.startsWith("no_reply_retry")) {
    return `a quiet-softened check-in must NOT chase harder, saw reason ${entry.reason}`;
  }
  return undefined;
}

/**
 * The watcher fired: its quiet-streak derivation stamped the fourth check-in's
 * persisted no-reply record with the softening decision and the streak length.
 */
function assertWatcherSoftened(
  _status: number,
  body: unknown,
): string | undefined {
  const task = findTask(body, fourth.id);
  if (typeof task === "string") return task;
  const metadata = isRecord(task.metadata) ? task.metadata : null;
  const state = isRecord(metadata?.noReplyState) ? metadata.noReplyState : null;
  const policy = isRecord(metadata?.noReplyPolicy)
    ? metadata.noReplyPolicy
    : null;
  if (state?.quietStreakSoftened !== true) {
    return `expected quietStreakSoftened=true (watcher fired), saw ${JSON.stringify(state)}`;
  }
  if (typeof state.quietStreakDays !== "number" || state.quietStreakDays < 3) {
    return `expected quietStreakDays >= 3 (threshold reached), saw ${JSON.stringify(state.quietStreakDays)}`;
  }
  if (state.appliedReminderIntensity !== "minimal") {
    return `expected softened intensity 'minimal', saw ${JSON.stringify(state.appliedReminderIntensity)}`;
  }
  if (policy?.maxRetries !== 0) {
    return `expected the softened ladder to drop retries (maxRetries 0), saw ${JSON.stringify(policy)}`;
  }
  return undefined;
}

export default scenario({
  id: "elderly-week1-quiet-user-watcher-escalates",
  lane: "live-only",
  title:
    "Elderly week-1: three unanswered mornings trip the quiet-user watcher — the next check-in softens, never chases",
  domain: "lifeops",
  tags: [
    "lifeops",
    "persona",
    "elderly",
    "scheduled-tasks",
    "quiet-user-watcher",
    "week1",
    "14354",
  ],
  isolation: "shared-runtime",
  requires: {
    plugins: [
      "@elizaos/plugin-scheduling",
      "@elizaos/plugin-personal-assistant",
    ],
  },
  seed: [
    {
      type: "custom",
      name: "register delivery channel + reset captured state",
      apply: async (ctx): Promise<string | undefined> => {
        fourth.id = null;
        const { registerDeliveryChannel } = await import(
          "./_helpers/elderly-week1"
        );
        return registerDeliveryChannel(ctx, DELIVERY, ledger);
      },
    },
  ],
  rooms: [{ id: "main", source: "telegram", title: "Elderly Week-1 Quiet" }],
  turns: [
    // Build the three-day ignored-check-in streak through the REAL fire/expire path.
    createStreakCheckin(0),
    fireStreakCheckin(0),
    expireStreakCheckin(0),
    createStreakCheckin(1),
    fireStreakCheckin(1),
    expireStreakCheckin(1),
    createStreakCheckin(2),
    fireStreakCheckin(2),
    expireStreakCheckin(2),
    {
      kind: "api",
      name: "the fourth-day check-in (would normally earn a +24h retry)",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "checkin",
        promptInstructions:
          "Good morning — thinking of you. How are you doing?",
        trigger: { kind: "once", atIso: FOURTH_FIRE.toISOString() },
        priority: "medium",
        completionCheck: {
          kind: "user_replied_within",
          followupAfterMinutes: 60,
          params: { lookbackMinutes: 60 },
        },
        output: { destination: "channel", target: `${DELIVERY}:owner` },
        respectsGlobalPause: false,
        source: "default_pack",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-checkin-fourth`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId(fourth),
    },
    {
      kind: "tick",
      name: "the fourth check-in fires",
      worker: "lifeops_scheduler",
      options: { now: FOURTH_FIRE.toISOString(), scheduledTaskLimit: 50 },
    },
    {
      kind: "tick",
      name: "still no answer → quiet-user watcher softens it to terminal",
      worker: "lifeops_scheduler",
      options: { now: FOURTH_TIMEOUT.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertFourthSoftenedTerminal,
    },
    {
      kind: "api",
      name: "the persisted check-in carries the watcher's quiet-streak decision",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks",
      expectedStatus: 200,
      assertResponse: assertWatcherSoftened,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "the fourth check-in was created and softened",
      predicate: (): string | undefined =>
        fourth.id === null ? "fourth check-in was never created" : undefined,
    },
  ],
});
