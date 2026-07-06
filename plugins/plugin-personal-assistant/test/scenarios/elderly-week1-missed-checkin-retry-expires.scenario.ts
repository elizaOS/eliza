/**
 * Elderly week-1 loop — the missed-check-in no-reply leg, proven structurally.
 *
 * Her family installs the app for exactly this: the daily check-in fires, and
 * on the day she does not answer, the assistant retries ONCE and then lets the
 * check-in expire — it never re-nags her all day. This drives the REAL
 * ScheduledTask spine (create through REST, fire/timeout through logical-clock
 * ticks; no LLM routing in the loop) and asserts the persisted no-reply
 * transitions read back off the real store:
 *
 *   fire → completion timeout (retryCount 0→1, `no_reply_retry_1`, snoozed to
 *   the +24h retry) → retry fires → completion timeout (terminal `expired`,
 *   `terminalOutcome: "expired"`).
 *
 * This is the conservative no-reply contract for check-ins
 * (`defaultNoReplyPolicyFor` in `scheduler.ts`: `maxRetries: 1`,
 * `retryCadenceMinutes: [1440]`, `terminalStatus: "expired"`), pinned here in
 * the elderly persona's week-1 voice. The policy is set explicitly on the task
 * so the proof does not depend on owner reminder-intensity defaults.
 *
 * Keyless-runnable under the deterministic proxy (the fire's dispatch render is
 * satisfied by the proxy's default reply); `live-only` lane because the pinned
 * strict PR corpus currently cannot render scheduled dispatches under
 * `SCENARIO_LLM_PROXY_STRICT=1` (`dispatch-render.ts` calls `useModel` with no
 * registered strict fixture — a develop-side gap independent of this proof).
 *
 * Fail-without-fix anchor: revert the retry-then-terminal branch in
 * `handleCompletionTimeout` (`scheduler.ts`) so a check-in either re-nags
 * forever or expires on the first timeout, and the retryCount/terminalOutcome
 * assertions below fail.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import {
  captureTaskId,
  findTask,
  futureUtc,
  noReplyState,
  readTick,
} from "./_helpers/elderly-week1";

const SCENARIO_ID = "elderly-week1-missed-checkin-retry-expires";
const DELIVERY = "scenario_elderly_checkin_delivery";

const CHECKIN_FIRE = futureUtc(8, 0, 2); // day+2, 08:00 — her morning check-in
const FIRST_TIMEOUT = new Date(CHECKIN_FIRE.getTime() + 61 * 60_000); // +61m > 60m window
const RETRY_FIRE = new Date(FIRST_TIMEOUT.getTime() + 24 * 60 * 60_000); // +24h retry
const SECOND_TIMEOUT = new Date(RETRY_FIRE.getTime() + 61 * 60_000);

const ledger: unknown[] = [];
const checkin = { id: null as string | null };

function assertFired(reasonPrefix: string) {
  return (_status: number, body: unknown): string | undefined => {
    const tick = readTick(body, checkin.id);
    if (typeof tick === "string") return tick;
    if (tick.fires.length !== 1 || tick.fires[0]?.status !== "fired") {
      return `expected exactly one fired for the check-in, saw ${JSON.stringify(tick.fires)}`;
    }
    const reason = tick.fires[0]?.reason ?? "";
    if (!reason.startsWith(reasonPrefix)) {
      return `expected fire reason ~"${reasonPrefix}", saw "${reason}"`;
    }
    return undefined;
  };
}

/** First timeout must arm a single retry, not settle terminally. */
function assertRetryArmed(_status: number, body: unknown): string | undefined {
  const tick = readTick(body, checkin.id);
  if (typeof tick === "string") return tick;
  if (tick.timeouts.length !== 1) {
    return `expected exactly one completion timeout, saw ${JSON.stringify(tick.timeouts)}`;
  }
  const entry = tick.timeouts[0];
  if (!entry?.reason.startsWith("no_reply_retry_1")) {
    return `expected reason no_reply_retry_1, saw "${entry?.reason}"`;
  }
  if (entry.status !== "scheduled") {
    return `expected the retry to re-arm (status scheduled/snoozed), saw ${entry.status}`;
  }
  return undefined;
}

function assertRetryPersisted(
  _status: number,
  body: unknown,
): string | undefined {
  const task = findTask(body, checkin.id);
  if (typeof task === "string") return task;
  const state = noReplyState(task);
  if (typeof state === "string") return state;
  if (state.retryCount !== 1) {
    return `expected noReplyState.retryCount=1 after the first timeout, saw ${JSON.stringify(state.retryCount)}`;
  }
  if (typeof state.nextRetryAt !== "string") {
    return `expected a scheduled nextRetryAt, saw ${JSON.stringify(state.nextRetryAt)}`;
  }
  if (state.terminalOutcome !== undefined) {
    return `check-in must not be terminal after only one retry, saw terminalOutcome=${JSON.stringify(state.terminalOutcome)}`;
  }
  return undefined;
}

/** Second timeout must settle terminally as expired, never re-arm again. */
function assertExpired(_status: number, body: unknown): string | undefined {
  const tick = readTick(body, checkin.id);
  if (typeof tick === "string") return tick;
  if (tick.timeouts.length !== 1) {
    return `expected exactly one completion timeout, saw ${JSON.stringify(tick.timeouts)}`;
  }
  const entry = tick.timeouts[0];
  if (entry?.status !== "expired") {
    return `expected the check-in to expire, saw status ${entry?.status}`;
  }
  if (entry.reason.startsWith("no_reply_retry")) {
    return `an expired check-in must not re-arm a retry, saw reason ${entry.reason}`;
  }
  return undefined;
}

function assertTerminalPersisted(
  _status: number,
  body: unknown,
): string | undefined {
  const task = findTask(body, checkin.id);
  if (typeof task === "string") return task;
  const stateRecord = task.state;
  const status = (stateRecord as { status?: unknown })?.status;
  if (status !== "expired") {
    return `expected task status=expired, saw ${JSON.stringify(status)}`;
  }
  const state = noReplyState(task);
  if (typeof state === "string") return state;
  if (state.terminalOutcome !== "expired") {
    return `expected noReplyState.terminalOutcome="expired", saw ${JSON.stringify(state.terminalOutcome)}`;
  }
  if (state.retryCount !== 1) {
    return `expected exactly one retry before expiry, saw retryCount=${JSON.stringify(state.retryCount)}`;
  }
  return undefined;
}

export default scenario({
  id: "elderly-week1-missed-checkin-retry-expires",
  lane: "live-only",
  title:
    "Elderly week-1: unanswered morning check-in retries once (+24h) then expires, never re-nagged",
  domain: "lifeops",
  tags: [
    "lifeops",
    "persona",
    "elderly",
    "scheduled-tasks",
    "no-reply",
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
        checkin.id = null;
        const { registerDeliveryChannel } = await import(
          "./_helpers/elderly-week1"
        );
        return registerDeliveryChannel(ctx, DELIVERY, ledger);
      },
    },
  ],
  rooms: [{ id: "main", source: "telegram", title: "Elderly Week-1 Check-in" }],
  turns: [
    {
      kind: "api",
      name: "seed her daily morning check-in",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "checkin",
        promptInstructions:
          "Gentle morning check-in for the owner: say good morning warmly and ask how she is doing today. One short question.",
        trigger: { kind: "once", atIso: CHECKIN_FIRE.toISOString() },
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
        idempotencyKey: `${SCENARIO_ID}-checkin`,
        metadata: {
          scenario: SCENARIO_ID,
          noReplyPolicy: {
            maxRetries: 1,
            retryCadenceMinutes: [24 * 60],
            terminalStatus: "expired",
            terminalReason: "no_reply_checkin_expired",
          },
        },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId(checkin),
    },
    {
      kind: "tick",
      name: "morning tick: the check-in fires",
      worker: "lifeops_scheduler",
      options: { now: CHECKIN_FIRE.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertFired("once_due"),
    },
    {
      kind: "tick",
      name: "she does not answer within the hour → single retry armed (+24h)",
      worker: "lifeops_scheduler",
      options: { now: FIRST_TIMEOUT.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertRetryArmed,
    },
    {
      kind: "api",
      name: "the persisted check-in shows retryCount 0→1, not terminal",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks",
      expectedStatus: 200,
      assertResponse: assertRetryPersisted,
    },
    {
      kind: "tick",
      name: "next day: the retry fires once at the promised +24h instant",
      worker: "lifeops_scheduler",
      options: { now: RETRY_FIRE.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertFired("scheduled_override_due"),
    },
    {
      kind: "tick",
      name: "still no answer → the check-in expires (never a third nag)",
      worker: "lifeops_scheduler",
      options: { now: SECOND_TIMEOUT.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertExpired,
    },
    {
      kind: "api",
      name: "the persisted check-in is terminally expired, one retry only",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks",
      expectedStatus: 200,
      assertResponse: assertTerminalPersisted,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "the check-in was created and driven to a terminal expiry",
      predicate: (): string | undefined =>
        checkin.id === null ? "check-in task was never created" : undefined,
    },
  ],
});
