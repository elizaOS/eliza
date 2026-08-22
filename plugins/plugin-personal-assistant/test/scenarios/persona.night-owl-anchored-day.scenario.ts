/**
 * B1 night-owl-anchored-day (pr-deterministic). Deterministic ScheduledTask
 * proof for noor_night's anchored day: reminders fire relative to HER schedule,
 * not a hardcoded 9am. Two anchored triggers are exercised against a fixed
 * logical clock (no LLM, no key):
 *
 *   1. a `during_window` "morning brief" fires INSIDE her owner-defined morning
 *      window (12:00–14:00, i.e. noon, not the neurotypical 07:00) and NOT at a
 *      wall-clock 09:00 tick — the flexible-window primitive tracks owner facts;
 *   2. a `relative_to_anchor` reminder fires relative to her wake-confirmation
 *      anchor + offset, again independent of any fixed clock time.
 *
 * Asserts STRUCTURAL outcomes (which task fires, and that a 09:00 tick fires
 * NOTHING), never routing. Owner facts (timezone + a noon morning window) are
 * seeded through the REAL OwnerFactStore; tasks are created through the REAL
 * REST surface; delivery goes through a scenario-registered always-delivering
 * channel so fires have a real surface. Run keyless with `TZ=UTC` so window math
 * is unambiguous.
 *
 * Maps to LifeOpsBench nightowl.anchored.morning_brief_first_hour_after_wake /
 * wake_relative_deploy_ping; the live conversational judge of "anchor, don't
 * assume 9am" stays on the bench LIVE surface. The realization of the bench
 * capture in the deterministic surface is "exactly one real fire+delivery of the
 * anchored task at HER instant, none at the 9am tick" — the scheduler-side analog
 * the keyless proxy can prove, since LifeOps definitions are only created through
 * a live model call.
 *
 * Fail-without-fix anchors:
 *   - Revert the `during_window` window resolution in
 *     `plugins/plugin-scheduling/src/scheduled-task/next-fire-at.ts` so the brief
 *     ignores the seeded owner window and reverts to a default morning hour, and
 *     the 09:00 tick fires it (the "nothing fires at 9am" turn fails) while the
 *     noon tick does not (the "fires inside her window" turn fails).
 *   - Revert `relative_to_anchor` offset handling so the wake reminder no longer
 *     tracks the wake anchor and the noon-window fire turn fails.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "persona.night-owl-anchored-day";
const DELIVERY_CHANNEL_KIND = "scenario_night_owl_delivery";

// ---------------------------------------------------------------------------
// Fixed logical clock, far in the future so ONLY the injected tick `now` decides
// dueness. Timezone UTC so window math is unambiguous. Noor's morning window is
// 12:00–14:00 (noon is "morning" for a night owl); the wake anchor falls back to
// morningWindow.start (12:00) when no explicit wake confirmation is recorded.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

function futureDateAtUtc(
  hour: number,
  minute: number,
  daysAhead: number,
): Date {
  const base = new Date(Date.now() + daysAhead * DAY_MS);
  base.setUTCHours(hour, minute, 0, 0);
  return base;
}

// Two days ahead so each task's schedule-time next_fire_at is well before every
// tick. 09:00 is the neurotypical-default trap; noon is inside Noor's window.
const NEUROTYPICAL_9AM_TICK = futureDateAtUtc(9, 0, 2); // 09:00 — she is asleep
// 12:35 is inside her window (12:00–14:00) AND strictly after the wake anchor
// occurrence (morningWindow.start 12:00 + 30m offset = 12:30), so both fire.
const INSIDE_HER_MORNING_TICK = futureDateAtUtc(12, 35, 2);

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

// assertResponse receives only (status, body) — captured ids live in module
// state, reset by the seed (mirrors persona.flexible-scheduling).
const capturedTaskIds: { brief: string | null; wake: string | null } = {
  brief: null,
  wake: null,
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedFactsAndChannel(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.brief = null;
  capturedTaskIds.wake = null;
  const runtime = ctx.runtime as RuntimeLike;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario night-owl delivery probe" },
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

  // Seed owner facts through the REAL store: a NOON morning window — the whole
  // point of the pack. during_window / relative_to_anchor read this at tick time.
  const { resolveOwnerFactStore } = await import(
    "@elizaos/plugin-personal-assistant/plugin"
  );
  const store = resolveOwnerFactStore(
    ctx.runtime as unknown as Parameters<typeof resolveOwnerFactStore>[0],
  );
  await store.update(
    {
      timezone: "UTC",
      morningWindow: { startLocal: "12:00", endLocal: "14:00" },
      eveningWindow: { startLocal: "20:00", endLocal: "23:00" },
      quietHours: { startLocal: "04:00", endLocal: "11:30", timezone: "UTC" },
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

function notFiredFor(
  slot: keyof typeof capturedTaskIds,
): (status: number, body: unknown) => string | undefined {
  return (_status: number, body: unknown): string | undefined => {
    const fires = firesForTask(body, capturedTaskIds[slot]);
    if (typeof fires === "string") return fires;
    const fired = fires.filter((f) => f.status === "fired");
    if (fired.length !== 0) {
      return `expected ${slot} NOT to fire at the 9am tick, saw ${JSON.stringify(fired)}`;
    }
    return undefined;
  };
}

// At the neurotypical 09:00 tick, NEITHER anchored task may fire — that is the
// whole point: her day is not pinned to a default morning hour.
function neitherFiresAt9am(_status: number, body: unknown): string | undefined {
  return (
    notFiredFor("brief")(_status, body) ?? notFiredFor("wake")(_status, body)
  );
}

// Both anchored reminders fire in the SAME tick inside her noon window: the
// during_window brief and the wake-anchored (wake.confirmed + 30m) reminder are
// both due at 12:35 — proving both anchor to HER schedule, not a fixed clock.
function bothFireInHerWindow(
  _status: number,
  body: unknown,
): string | undefined {
  return firedFor("brief")(_status, body) ?? firedFor("wake")(_status, body);
}

export default scenario({
  // Literal (not SCENARIO_ID) so the corpus guard + coverage gate, which read
  // the id statically, resolve it.
  id: "persona.night-owl-anchored-day",
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        name: "dispatch-body",
        match: {
          modelType: "TEXT_SMALL",
          prompt: { includes: "\nInstruction:\n" },
        },
        response: { text: "Heads up: you have an update from your assistant." },
        cardinality: 2,
      },
    ],
  },
  title:
    "Night owl anchored day: brief fires in her noon window and a wake-anchored reminder fires relative to wake — never at 9am",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "night-owl",
    "personas",
    "scheduled-tasks",
    "12283",
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
      name: "seed owner facts (noon morning window) and delivery channel",
      apply: seedFactsAndChannel,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Night Owl Anchored Day",
    },
  ],
  turns: [
    // The morning brief is a during_window task tied to HER morning window.
    {
      kind: "api",
      name: "create the during_window morning brief",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "morning brief, whenever her morning actually is",
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
        idempotencyKey: `${SCENARIO_ID}-morning-brief`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("brief"),
    },
    // The deploy-check reminder is anchored to wake + 30m, not a wall clock.
    {
      kind: "api",
      name: "create the wake-anchored deploy reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "ping about the deploy, an hour after she is up",
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
        idempotencyKey: `${SCENARIO_ID}-wake-deploy`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("wake"),
    },
    // The neurotypical 9am tick: she is asleep. NOTHING anchored may fire.
    {
      kind: "tick",
      name: "tick at 09:00 (the neurotypical default) → nothing fires",
      worker: "lifeops_scheduler",
      options: {
        now: NEUROTYPICAL_9AM_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: neitherFiresAt9am,
    },
    // Inside her noon window: BOTH the during_window brief and the
    // wake-anchored reminder (morningWindow.start 12:00 + 30m = 12:30, now past)
    // are due at the same tick — each anchors to her schedule, not to 9am.
    {
      kind: "tick",
      name: "tick at 12:35 (inside her window / after wake anchor) → both fire",
      worker: "lifeops_scheduler",
      options: {
        now: INSIDE_HER_MORNING_TICK.toISOString(),
        scheduledTaskLimit: 50,
      },
      assertResponse: bothFireInHerWindow,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "both anchored reminders delivered — in her window, never at 9am",
      predicate: (): string | undefined => {
        // brief fire + wake fire = exactly 2 deliveries; nothing delivered at
        // the 9am tick (that turn asserted no fires).
        if (deliveryLedger.length !== 2) {
          return `expected exactly 2 deliveries (brief + wake, both in her noon window), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
