/**
 * A1 adhd-capture-and-start (pr-deterministic). Deterministic ScheduledTask
 * proof for the ADHD "hyperfocus guardrail": an important standup nudge must
 * break through at its protective instant, while a low-value focus-break ping
 * is HELD so hyperfocus is not interrupted for something unimportant. Drives the
 * REAL scheduler tick (logical clock, no LLM, no key), asserts STRUCTURAL
 * outcomes (which task fires vs. defers, and what actually gets delivered), not
 * routing. Maps to LifeOpsBench live.adhd.hyperfocus_standup_guardrail; the live
 * conversational judge of the same behavior stays on the bench LIVE surface.
 *
 * The realization of the bench "delta:1" capture in the deterministic surface is
 * "exactly one real fire+delivery of the guardrail task" — the scheduler-side
 * analog that the keyless proxy can actually prove, since LifeOps definitions
 * are only created through a live model call.
 *
 * Owner facts (timezone, quietHours) are seeded through the REAL OwnerFactStore.
 * Tasks are created through the REAL REST surface. Delivery goes through a
 * scenario-registered always-delivering channel so fires have a real surface.
 * Run keyless with `TZ=UTC` so quiet-hours window math is unambiguous.
 *
 * Fail-without-fix anchors:
 *   - Revert the `once`-trigger dueness / next_fire_at in
 *     `plugins/plugin-scheduling/src/scheduled-task/next-fire-at.ts` and the
 *     high-priority standup nudge never becomes due at the protective tick — the
 *     "fires exactly once" turn (and the single-delivery finalCheck) fails.
 *   - Revert the `quiet_hours` gate's low-priority hold (honor
 *     `highPriorityBypass` only for high priority) so the low-value focus ping
 *     fires during quiet hours — the "defers, not fires" turn fails and the
 *     delivery ledger grows past one.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "adhd-hyperfocus-guardrail-protects-standup";
const DELIVERY_CHANNEL_KIND = "scenario_hyperfocus_guardrail_delivery";

// ---------------------------------------------------------------------------
// Fixed logical clock, far in the future so ONLY the injected tick `now`
// decides dueness. UTC quiet hours 22:00–06:00. The important standup nudge is
// a `once` at 23:05; the low-value ping is a quiet-hours-gated interval.
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

const GUARDRAIL_INSTANT = futureDateAtUtc(23, 5, 2); // once nudge due 23:05
const PRE_TICK = futureDateAtUtc(22, 30, 2); // 22:30 — inside quiet, before nudge
const FIRE_TICK = futureDateAtUtc(23, 10, 2); // 23:10 — inside quiet, after nudge

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
const capturedTaskIds: { guardrail: string | null; focusPing: string | null } =
  { guardrail: null, focusPing: null };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedFactsAndChannel(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.guardrail = null;
  capturedTaskIds.focusPing = null;
  const runtime = ctx.runtime as RuntimeLike;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario hyperfocus guardrail delivery probe" },
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
      return `expected ${slot} NOT to fire, saw ${JSON.stringify(fired)}`;
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

function bothAtPreTick(_status: number, body: unknown): string | undefined {
  return (
    notFiredFor("guardrail")(_status, body) ??
    deferredFor("focusPing", "quiet_hours")(_status, body)
  );
}

export default scenario({
  id: "adhd-hyperfocus-guardrail-protects-standup",
  lane: "pr-deterministic",
  title:
    "ADHD hyperfocus guardrail: important standup nudge breaks through, low-value ping held",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "adhd",
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
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "ADHD Hyperfocus Guardrail",
    },
  ],
  turns: [
    // The load-bearing standup nudge: a once reminder at the protective instant,
    // high priority, ungated — it must break through hyperfocus.
    {
      kind: "api",
      name: "create the high-priority standup guardrail nudge",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions:
          "standup starts soon — surface it before hyperfocus swallows the morning",
        trigger: { kind: "once", atIso: GUARDRAIL_INSTANT.toISOString() },
        priority: "high",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-standup-nudge`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("guardrail"),
    },
    // The low-value focus-break ping: gated by quiet_hours so it is HELD during
    // the protected focus window rather than interrupting hyperfocus.
    {
      kind: "api",
      name: "create the low-priority focus-break ping (quiet-hours gated)",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "optional: consider a short break",
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
        idempotencyKey: `${SCENARIO_ID}-focus-ping`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureTaskId("focusPing"),
    },
    // Before the protective instant: the guardrail is not yet due (hyperfocus is
    // NOT interrupted early), and the low-value ping is already being held.
    {
      kind: "tick",
      name: "tick before the nudge instant → guardrail silent, ping held",
      worker: "lifeops_scheduler",
      options: { now: PRE_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: bothAtPreTick,
    },
    // At the protective instant: the standup nudge breaks through exactly once.
    // (The low-value ping already deferred at the earlier tick and its interval
    // re-armed past this instant — its being-held is proved at PRE_TICK above and
    // by the single-delivery finalCheck, so it is not re-asserted here.)
    {
      kind: "tick",
      name: "tick at the nudge instant → standup nudge fires once",
      worker: "lifeops_scheduler",
      options: { now: FIRE_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: firedFor("guardrail"),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly one delivery — the standup nudge, never the low-value ping",
      predicate: (): string | undefined => {
        if (deliveryLedger.length !== 1) {
          return `expected exactly 1 delivery (the standup guardrail nudge; the low-value ping is held), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
