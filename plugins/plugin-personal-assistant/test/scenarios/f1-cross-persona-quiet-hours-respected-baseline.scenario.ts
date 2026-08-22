/**
 * F1 neurotypical-control-adversarial (pr-deterministic). CONTROL/CANARY: a
 * neutral owner's STANDARD quiet-hours window (22:00–06:00 UTC) is honored
 * exactly as-configured — a low-priority ping is HELD inside quiet hours and a
 * high-priority reminder breaks through — with no persona accommodation altering
 * the boundary. Proves the B1 night-owl inverted-sleep re-anchoring and the E1
 * low-activation softening do NOT leak into a plain profile: the gate fires on
 * the literal configured window, not on an "observed wake" or "quiet streak".
 * Drives the REAL scheduler tick (logical clock, no LLM, no key) and asserts
 * STRUCTURAL outcomes (which task fires vs. defers and what is delivered), not
 * routing.
 *
 * Owner facts (timezone, quietHours) are seeded through the REAL OwnerFactStore.
 * Tasks are created through the REAL REST surface. Delivery goes through a
 * scenario-registered always-delivering channel so fires have a real surface.
 * Run keyless with `TZ=UTC` so quiet-hours window math is unambiguous.
 *
 * Fail-without-fix anchor: revert the `quiet_hours` gate's low-priority hold
 * (honor `highPriorityBypass` only for high priority) in
 * `plugins/plugin-scheduling` so the low-value ping fires during quiet hours —
 * the "defers, not fires" turn fails and the delivery ledger grows past one.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "f1-cross-persona-quiet-hours-respected-baseline";
const DELIVERY_CHANNEL_KIND = "scenario_f1_control_quiet_hours_delivery";

const DAY_MS = 24 * 60 * 60 * 1000;

// Fixed logical clock, far ahead so only the injected tick `now` decides
// dueness. UTC quiet hours 22:00–06:00. The important reminder is a `once` at
// 23:05; the low-value ping is a quiet-hours-gated interval.
function futureDateAtUtc(
  hour: number,
  minute: number,
  daysAhead: number,
): Date {
  const base = new Date(Date.now() + daysAhead * DAY_MS);
  base.setUTCHours(hour, minute, 0, 0);
  return base;
}

const IMPORTANT_INSTANT = futureDateAtUtc(23, 5, 2); // once reminder due 23:05
const PRE_TICK = futureDateAtUtc(22, 30, 2); // 22:30 — inside quiet, before reminder
const FIRE_TICK = futureDateAtUtc(23, 10, 2); // 23:10 — inside quiet, after reminder

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
const captured: { important: string | null; ping: string | null } = {
  important: null,
  ping: null,
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedFactsAndChannel(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  deliveryLedger.length = 0;
  captured.important = null;
  captured.ping = null;
  const runtime = ctx.runtime as RuntimeLike;
  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario F1 control quiet-hours delivery probe" },
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
      quietHours: { startLocal: "22:00", endLocal: "06:00", timezone: "UTC" },
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
  slot: keyof typeof captured,
): (status: number, body: unknown) => string | undefined {
  return (_status: number, body: unknown): string | undefined => {
    if (!isRecord(body) || !isRecord(body.task)) {
      return `expected {task} response, saw ${JSON.stringify(body)}`;
    }
    const task = body.task;
    if (typeof task.taskId !== "string" || task.taskId.length === 0) {
      return `expected task.taskId string, saw ${JSON.stringify(task.taskId)}`;
    }
    captured[slot] = task.taskId;
    return undefined;
  };
}

// Before the reminder instant: the important reminder is not yet due, and the
// low-value ping is already held by the standard quiet-hours gate.
function bothAtPreTick(_status: number, body: unknown): string | undefined {
  const importantFires = firesForTask(body, captured.important);
  if (typeof importantFires === "string") return importantFires;
  if (importantFires.some((f) => f.status === "fired")) {
    return `important reminder must not fire before its instant, saw ${JSON.stringify(importantFires)}`;
  }
  const pingFires = firesForTask(body, captured.ping);
  if (typeof pingFires === "string") return pingFires;
  if (pingFires.some((f) => f.status === "fired")) {
    return `low-value ping must be held by standard quiet hours, saw ${JSON.stringify(pingFires)}`;
  }
  const held = pingFires.find((f) => f.reason.includes("quiet_hours"));
  if (!held) {
    return `expected the ping deferred with a quiet_hours reason, saw ${JSON.stringify(pingFires)}`;
  }
  return undefined;
}

// At the reminder instant: the high-priority reminder breaks through the quiet
// window exactly once (standard highPriorityBypass), the ping stays held.
function importantFiresPingHeld(
  _status: number,
  body: unknown,
): string | undefined {
  const importantFires = firesForTask(body, captured.important);
  if (typeof importantFires === "string") return importantFires;
  if (importantFires.length !== 1 || importantFires[0]?.status !== "fired") {
    return `expected the high-priority reminder to break through once, saw ${JSON.stringify(importantFires)}`;
  }
  const pingFires = firesForTask(body, captured.ping);
  if (typeof pingFires === "string") return pingFires;
  if (pingFires.some((f) => f.status === "fired")) {
    return `low-value ping must stay held during quiet hours, saw ${JSON.stringify(pingFires)}`;
  }
  return undefined;
}

export default scenario({
  id: "f1-cross-persona-quiet-hours-respected-baseline",
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
        cardinality: 1,
      },
    ],
  },
  title:
    "Control baseline: standard quiet hours hold a low-value ping, a high-priority reminder still breaks through",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "control",
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
      name: "seed owner facts (standard quiet hours) and delivery channel",
      apply: seedFactsAndChannel,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "F1 Control Quiet Hours Baseline",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create the high-priority reminder inside quiet hours",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "sign the field-trip permission slip tonight",
        trigger: { kind: "once", atIso: IMPORTANT_INSTANT.toISOString() },
        priority: "high",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-important`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("important"),
    },
    {
      kind: "api",
      name: "create the low-priority ping (standard quiet-hours gated)",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "optional: tidy the entryway",
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
        idempotencyKey: `${SCENARIO_ID}-ping`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("ping"),
    },
    {
      kind: "tick",
      name: "tick before the reminder instant → reminder silent, ping held by standard quiet hours",
      worker: "lifeops_scheduler",
      options: { now: PRE_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: bothAtPreTick,
    },
    {
      kind: "tick",
      name: "tick at the reminder instant → high-priority reminder breaks through once, ping still held",
      worker: "lifeops_scheduler",
      options: { now: FIRE_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: importantFiresPingHeld,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly one delivery — the high-priority reminder, never the quiet-hours-held ping",
      predicate: (): string | undefined => {
        if (deliveryLedger.length !== 1) {
          return `expected exactly 1 delivery (the high-priority reminder; the ping is held by standard quiet hours), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
