/**
 * Deterministic persona-scheduling proof for the LifeOps ScheduledTask spine
 * (issue #12186, task B5). Drives the REAL scheduler tick (logical clock, no
 * LLM, no key) and asserts STRUCTURAL outcomes, not routing:
 *
 *   1. during_window fires INSIDE the owner's morning window — the
 *      flexible-scheduling primitive tracks owner facts.
 *   2. relative_to_anchor fires relative to the wake anchor.
 *   3. quiet_hours DEFERS a low-priority reminder when the tick lands inside
 *      the owner's quiet window (gate-defer, not fired).
 *   4. no_recent_user_message_in ALLOWS a proactive poke once the user is
 *      quiet (this scenario exercises only the ALLOW branch).
 *
 * Owner facts (timezone, morningWindow, quietHours) are seeded through the REAL
 * OwnerFactStore. Tasks are created through the REAL REST surface. Delivery
 * goes through a scenario-registered always-delivering channel so the keyless
 * runtime has a real surface to accept fires.
 *
 * SCOPE NOTE (honest): the `no_recent_user_message_in` DEFER/suppression branch
 * is NOT exercised here — a scenario turn cannot inject the mid-run activity
 * signal (bus publish / ActivityProfile.lastSeenAt) the gate reads. That branch
 * is proven headlessly, through the SAME real runner, by the unit + simulation
 * tests: `plugins/plugin-scheduling/.../gate-registry.test.ts` (built-in
 * fallback defers), `plugins/plugin-personal-assistant/.../activity-gates.test.ts`
 * (PA reader defers on a recent heartbeat), and
 * `plugins/plugin-personal-assistant/test/persona-packs.simulation.test.ts`
 * (a gated poke is suppressed while active and fires once quiet).
 *
 * Runs UTC-only: the corpus lane pins `TZ=UTC` so the seeded owner timezone
 * (UTC) matches the process default. Otherwise `reconcileTravelActive` reads
 * the host zone as a device-timezone divergence, opens a provisional travel
 * record, and the derived travel timezone overrides UTC — pushing the injected
 * ticks outside the morning window so `during_window` never fires.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "persona.flexible-scheduling";
const DELIVERY_CHANNEL_KIND = "scenario_persona_delivery";

// ---------------------------------------------------------------------------
// Fixed logical clock. All ticks are far in the future so ONLY the injected
// `now` decides dueness. Timezone is UTC so window math is unambiguous.
// morningWindow = 07:00–10:00; quietHours = 22:00–06:00.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function futureDateAtUtcHour(
  hour: number,
  minute: number,
  daysAhead: number,
): Date {
  const base = new Date(Date.now() + daysAhead * DAY_MS);
  base.setUTCHours(hour, minute, 0, 0);
  return base;
}

// Two days ahead so the schedule-time next_fire_at (computed at wall clock) is
// well before every tick below.
const INSIDE_MORNING_TICK = futureDateAtUtcHour(8, 0, 2); // 08:00 — inside 07-10
const QUIET_HOURS_TICK = futureDateAtUtcHour(23, 0, 2); // 23:00 — inside quiet
const DAYTIME_TICK = futureDateAtUtcHour(15, 0, 3); // 15:00 next day — awake

interface ChannelContributionLike {
  kind: string;
  describe: { label: string };
  capabilities: {
    send: boolean;
    read: boolean;
    reminders: boolean;
    voice: boolean;
    attachments: boolean;
    quietHoursAware: boolean;
  };
  send?(payload: unknown): Promise<{ ok: true; messageId: string }>;
}

interface ChannelRegistryLike {
  register(contribution: ChannelContributionLike): void;
  get(kind: string): ChannelContributionLike | null;
}

interface RuntimeLike {
  channelRegistry?: ChannelRegistryLike;
}

const deliveryLedger: unknown[] = [];

// Task ids captured from each create turn. `assertResponse` receives only
// (status, body) — not the scenario context — so captured ids live in module
// state (reset by the seed), mirroring the recurrence scenario.
const capturedTaskIds: {
  window: string | null;
  anchor: string | null;
  quiet: string | null;
  poke: string | null;
} = { window: null, anchor: null, quiet: null, poke: null };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedFactsAndChannel(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.window = null;
  capturedTaskIds.anchor = null;
  capturedTaskIds.quiet = null;
  capturedTaskIds.poke = null;
  const runtime = ctx.runtime as RuntimeLike;

  // 1. Register an always-delivering probe channel so fires have a real surface.
  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario persona delivery probe" },
      capabilities: {
        send: true,
        read: false,
        reminders: true,
        voice: false,
        attachments: false,
        quietHoursAware: false,
      },
      async send(payload: unknown): Promise<{ ok: true; messageId: string }> {
        deliveryLedger.push(payload);
        return {
          ok: true,
          messageId: `${SCENARIO_ID}-delivered-${deliveryLedger.length}`,
        };
      },
    });
  }

  // 2. Seed owner facts through the REAL store — timezone + morning window +
  // quiet hours. This is what during_window / quiet_hours read at tick time.
  const { resolveOwnerFactStore } = await import(
    "@elizaos/plugin-personal-assistant/plugin"
  );
  const store = resolveOwnerFactStore(
    ctx.runtime as unknown as Parameters<typeof resolveOwnerFactStore>[0],
  );
  await store.update(
    {
      timezone: "UTC",
      morningWindow: { startLocal: "07:00", endLocal: "10:00" },
      eveningWindow: { startLocal: "18:00", endLocal: "22:00" },
      quietHours: { startLocal: "22:00", endLocal: "06:00", timezone: "UTC" },
    },
    { source: "profile_save", recordedAt: new Date().toISOString() },
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// Tick response readers.
// ---------------------------------------------------------------------------

interface FireEntry {
  taskId: string;
  status: string;
  reason: string;
}

function readFires(body: unknown): FireEntry[] | string {
  if (!isRecord(body) || body.success !== true) {
    return `expected tick success=true, saw ${JSON.stringify(body)}`;
  }
  const raw = body.scheduledTaskFires;
  if (!Array.isArray(raw)) return "expected scheduledTaskFires array";
  const fires: FireEntry[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.taskId !== "string" ||
      typeof entry.status !== "string" ||
      typeof entry.reason !== "string"
    ) {
      return `malformed scheduledTaskFires entry: ${JSON.stringify(entry)}`;
    }
    fires.push({
      taskId: entry.taskId,
      status: entry.status,
      reason: entry.reason,
    });
  }
  return fires;
}

function firesForTask(
  body: unknown,
  taskId: string | null,
): FireEntry[] | string {
  const fires = readFires(body);
  if (typeof fires === "string") return fires;
  if (typeof taskId !== "string" || taskId.length === 0) {
    return "captured taskId was not set by the create turn";
  }
  return fires.filter((fire) => fire.taskId === taskId);
}

function captureTaskId(
  slot: keyof typeof capturedTaskIds,
): (status: number, body: unknown) => string | undefined {
  return (_status: number, body: unknown): string | undefined => {
    if (!isRecord(body) || !isRecord(body.task)) {
      return `expected {task} response, saw ${JSON.stringify(body)}`;
    }
    const task = body.task;
    if (typeof task.taskId !== "string" || task.taskId.length === 0) {
      return `expected task.taskId string, saw ${JSON.stringify(task.taskId)}`;
    }
    capturedTaskIds[slot] = task.taskId;
    return undefined;
  };
}

function firedFor(
  slot: keyof typeof capturedTaskIds,
): (status: number, body: unknown) => string | undefined {
  return (_status: number, body: unknown): string | undefined => {
    const fires = firesForTask(body, capturedTaskIds[slot]);
    if (typeof fires === "string") return fires;
    if (fires.length !== 1 || fires[0]?.status !== "fired") {
      return `expected exactly one fired for ${slot}, saw ${JSON.stringify(fires)}`;
    }
    return undefined;
  };
}

function deferredFor(
  slot: keyof typeof capturedTaskIds,
  reasonPrefix: string,
): (status: number, body: unknown) => string | undefined {
  return (_status: number, body: unknown): string | undefined => {
    const fires = firesForTask(body, capturedTaskIds[slot]);
    if (typeof fires === "string") return fires;
    const fired = fires.filter((f) => f.status === "fired");
    if (fired.length !== 0) {
      return `expected ${slot} to defer, not fire, saw ${JSON.stringify(fired)}`;
    }
    const deferred = fires.find((f) => f.reason.includes(reasonPrefix));
    if (!deferred) {
      return `expected ${slot} deferred with reason ~"${reasonPrefix}", saw ${JSON.stringify(fires)}`;
    }
    return undefined;
  };
}

export default scenario({
  id: "persona.flexible-scheduling",
  lane: "pr-deterministic",
  title:
    "LifeOps persona scheduling: during_window / anchor firing, quiet_hours defer, activity-gated poke allow",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "personas",
    "scheduled-tasks",
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
      name: "seed owner facts (window + quiet hours) and delivery channel",
      apply: seedFactsAndChannel,
    },
  ],
  turns: [
    // -- during_window fires inside the learned morning window ---------------
    {
      kind: "api",
      name: "create a during_window morning reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "morning window flexible reminder",
        trigger: { kind: "during_window", windowKey: "morning" },
        priority: "low",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-morning-window`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("window"),
    },
    {
      kind: "tick",
      name: "tick INSIDE the morning window → during_window fires",
      worker: "lifeops_scheduler",
      options: {
        now: INSIDE_MORNING_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: firedFor("window"),
    },
    // -- relative_to_anchor fires relative to the wake anchor ---------------
    {
      kind: "api",
      name: "create a relative_to_anchor wake reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "just after wake reminder",
        trigger: {
          kind: "relative_to_anchor",
          anchorKey: "wake.confirmed",
          offsetMinutes: 30,
        },
        priority: "low",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-wake-anchor`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("anchor"),
    },
    {
      kind: "tick",
      name: "tick after the wake anchor + offset → anchor reminder fires",
      worker: "lifeops_scheduler",
      // 08:00 is 30m+ after the fallback morning.start anchor (07:00).
      options: {
        now: INSIDE_MORNING_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: firedFor("anchor"),
    },
    // -- quiet_hours defers a low-priority reminder -------------------------
    {
      kind: "api",
      name: "create a reminder gated by quiet_hours",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "should be held during quiet hours",
        trigger: { kind: "interval", everyMinutes: 60 },
        shouldFire: {
          compose: "all",
          gates: [
            { kind: "quiet_hours", params: { highPriorityBypass: true } },
          ],
        },
        priority: "low",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-quiet-hours`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("quiet"),
    },
    {
      kind: "tick",
      name: "tick inside quiet hours (23:00) → quiet_hours defers, no fire",
      worker: "lifeops_scheduler",
      options: { now: QUIET_HOURS_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: deferredFor("quiet", "quiet_hours"),
    },
    // -- no_recent_user_message_in suppresses a proactive poke while active -
    {
      kind: "api",
      name: "create a proactive poke gated by no_recent_user_message_in",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "checkin",
        promptInstructions: "proactive poke, suppressed while user active",
        trigger: { kind: "interval", everyMinutes: 60 },
        shouldFire: {
          compose: "all",
          gates: [
            { kind: "no_recent_user_message_in", params: { minutes: 30 } },
          ],
        },
        priority: "low",
        completionCheck: {
          kind: "user_replied_within",
          params: { lookbackMinutes: 120 },
        },
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-activity-suppress`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("poke"),
    },
    {
      kind: "tick",
      name: "user has no observed activity → poke ALLOWED (fires)",
      worker: "lifeops_scheduler",
      options: { now: DAYTIME_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: firedFor("poke"),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "at least the window + anchor + poke reminders delivered",
      predicate: (): string | undefined => {
        // window fire + anchor fire + poke fire = 3 deliveries minimum. The
        // quiet-hours task deferred (no delivery).
        if (deliveryLedger.length < 3) {
          return `expected >= 3 deliveries (window, anchor, poke), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
