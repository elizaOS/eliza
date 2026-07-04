/**
 * E1 low-activation-reengagement (pr-deterministic). Deterministic ScheduledTask
 * proof for the "one small thing, not the whole pile" morning nudge: a single
 * gentle high-priority morning pick breaks through exactly once at its instant,
 * while a low-value bulk-list ping is HELD (quiet-hours gated) so a
 * low-activation owner sees one concrete thing rather than the overwhelming
 * backlog. Drives the REAL scheduler tick (logical clock, no LLM, no key) and
 * asserts STRUCTURAL outcomes (which task fires vs. defers, and what actually
 * delivers), not routing. Maps to LifeOpsBench lowact.morning_single_priority_pick;
 * the live conversational judge of "pick ONE thing, warm tone" stays on the
 * bench LIVE surface.
 *
 * Owner facts (timezone, quietHours) are seeded through the REAL OwnerFactStore.
 * Tasks are created through the REAL REST surface. Delivery goes through a
 * scenario-registered always-delivering channel. Run keyless with `TZ=UTC` so
 * the quiet-hours window math is unambiguous.
 *
 * NO crisis guard is asserted (the mechanic is ordinary gentle scheduling;
 * #12780 crisis guard is not-planned).
 *
 * Fail-without-fix anchor:
 *   - Revert the `quiet_hours` gate's low-priority hold in
 *     `plugins/plugin-scheduling/src/scheduled-task/...` (honor
 *     `highPriorityBypass` only for high priority) and the low-value bulk-list
 *     ping fires during quiet hours — the "held" turn fails and the delivery
 *     ledger grows past one.
 *   - Revert the `once`-trigger dueness in `next-fire-at.ts` and the single
 *     morning pick never becomes due — the "fires once" turn fails.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "lowact-morning-single-priority-fires-once";
const DELIVERY_CHANNEL_KIND = "scenario_morning_priority_delivery";

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

// Quiet hours 22:00–10:00 (a low-activation late riser). Both ticks land INSIDE
// quiet hours: the single high-priority morning pick breaks through via
// `highPriorityBypass` at its instant, while the low-value whole-list ping stays
// held the whole time. Keeping both ticks inside quiet hours proves the pile is
// suppressed for the same reason at both moments — never surfacing on this owner.
const PICK_INSTANT = futureDateAtUtc(8, 0, 2); // inside quiet hours
const PRE_TICK = futureDateAtUtc(7, 0, 2); // inside quiet hours, before the pick
const FIRE_TICK = futureDateAtUtc(8, 5, 2); // inside quiet hours, after the pick

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
const capturedTaskIds: { pick: string | null; bulkPing: string | null } = {
  pick: null,
  bulkPing: null,
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedFactsAndChannel(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.pick = null;
  capturedTaskIds.bulkPing = null;
  const runtime = ctx.runtime as RuntimeLike;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario morning single-priority delivery probe" },
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

  const { resolveOwnerFactStore } = await import(
    "@elizaos/plugin-personal-assistant/plugin"
  );
  const store = resolveOwnerFactStore(
    ctx.runtime as unknown as Parameters<typeof resolveOwnerFactStore>[0],
  );
  await store.update(
    {
      timezone: "UTC",
      quietHours: { startLocal: "22:00", endLocal: "10:00", timezone: "UTC" },
    },
    { source: "profile_save", recordedAt: new Date().toISOString() },
  );
  return undefined;
}

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

function bulkPingHeldPickPending(
  _status: number,
  body: unknown,
): string | undefined {
  const pickFires = firesForTask(body, capturedTaskIds.pick);
  if (typeof pickFires === "string") return pickFires;
  if (pickFires.filter((f) => f.status === "fired").length !== 0) {
    return `the single pick must NOT fire before its instant, saw ${JSON.stringify(pickFires)}`;
  }
  const bulkFires = firesForTask(body, capturedTaskIds.bulkPing);
  if (typeof bulkFires === "string") return bulkFires;
  if (bulkFires.filter((f) => f.status === "fired").length !== 0) {
    return `the low-value bulk ping must be HELD in quiet hours, saw ${JSON.stringify(bulkFires)}`;
  }
  const deferred = bulkFires.find((f) => f.reason.includes("quiet_hours"));
  if (!deferred) {
    return `expected the bulk ping deferred by quiet_hours, saw ${JSON.stringify(bulkFires)}`;
  }
  return undefined;
}

export default scenario({
  id: "lowact-morning-single-priority-fires-once",
  lane: "pr-deterministic",
  title:
    "Low activation: one gentle morning pick fires once, the whole-list ping stays held",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "low-activation",
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
      name: "seed owner facts (quiet hours) and delivery channel",
      apply: seedFactsAndChannel,
    },
  ],
  turns: [
    // The single gentle morning pick: a `once` high-priority reminder just after
    // the late quiet-hours end — the ONE thing that surfaces.
    {
      kind: "api",
      name: "create the single gentle morning-priority pick",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "one small thing this morning — water the plant",
        trigger: { kind: "once", atIso: PICK_INSTANT.toISOString() },
        priority: "high",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-morning-pick`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("pick"),
    },
    // The overwhelming whole-list ping: a low-priority quiet-hours-gated interval
    // that is HELD so the backlog does not pile onto a low-activation owner.
    {
      kind: "api",
      name: "create the low-value whole-list ping (quiet-hours gated)",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "you still have 14 overdue tasks",
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
        idempotencyKey: `${SCENARIO_ID}-whole-list-ping`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("bulkPing"),
    },
    {
      kind: "tick",
      name: "tick inside quiet hours → pick pending, whole-list ping held",
      worker: "lifeops_scheduler",
      options: { now: PRE_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: bulkPingHeldPickPending,
    },
    {
      kind: "tick",
      name: "tick at the pick instant → the single morning pick fires once",
      worker: "lifeops_scheduler",
      options: { now: FIRE_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: firedFor("pick"),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly one delivery — the single pick, never the whole-list ping",
      predicate: (): string | undefined => {
        if (deliveryLedger.length !== 1) {
          return `expected exactly 1 delivery (the single morning pick; the whole-list ping is held), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
