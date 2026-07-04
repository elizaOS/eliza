/**
 * C1 traveler-timezone-truth (pr-deterministic). When a connection slips, the
 * assistant makes a RECOVERY MOVE — it actively re-times the affected reminder
 * to the new reality — rather than firing it at the now-stale original instant
 * or dropping it. Drives the REAL scheduler tick (logical clock, no LLM, no key)
 * and asserts the STRUCTURAL outcome: the boarding reminder does NOT fire at the
 * original instant (it was moved) and fires exactly once at the recovered
 * instant with `scheduled_override_due`. Maps to the bench premise
 * `live.traveler.flight_delay_disruption_recovery`; the live conversational
 * judge of "replanned, not just alerted" stays on the bench LIVE surface.
 *
 * The delay is applied through the REAL REST snooze verb (a re-time is the
 * scheduler-side realization of a recovery move) with an explicit `untilIso`, so
 * the proof is independent of host timezone. The recovery is proven by the
 * `scheduled_override_due` fire at the new instant AND the absence of any fire
 * at the original instant. Run keyless with `TZ=UTC`.
 *
 * Fail-without-fix anchor: revert the scheduled-override branch in
 * `plugin-scheduling/src/scheduled-task/next-fire-at.ts` /
 * `due.ts` (`scheduledOverrideDue`) so a re-timed row indexes at its ORIGINAL
 * trigger instant, and either the boarding reminder fires at the stale original
 * instant (the "not at the original" turn fails) or never fires at the recovered
 * instant (the "fires once, recovered" turn + delivery finalCheck fail).
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "traveler-disruption-recovery-missed-connection";
const DELIVERY_CHANNEL_KIND = "scenario_traveler_recovery_delivery";

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

// Original boarding instant, the delayed (recovered) instant, and ticks that
// straddle both. All far in the future so only the injected tick decides dueness.
const ORIGINAL_INSTANT = futureDateAtUtc(14, 0, 2); // boarding was 14:00
const RECOVERED_INSTANT = futureDateAtUtc(17, 30, 2); // delayed to 17:30
const ORIGINAL_TICK = futureDateAtUtc(14, 5, 2); // 14:05 — the original time
const RECOVERED_TICK = futureDateAtUtc(17, 35, 2); // 17:35 — after the recovery

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
const capturedTaskIds: { boarding: string | null } = { boarding: null };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedChannel(ctx: ScenarioContext): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.boarding = null;
  const runtime = ctx.runtime as RuntimeLike;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario traveler recovery delivery probe" },
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
  return undefined;
}

interface FireEntry {
  taskId: string;
  status: string;
  reason: string;
  occurrenceAtIso?: string;
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
      occurrenceAtIso:
        typeof entry.occurrenceAtIso === "string"
          ? entry.occurrenceAtIso
          : undefined,
    });
  }
  return fires;
}

function boardingFires(body: unknown): FireEntry[] | string {
  const fires = readFires(body);
  if (typeof fires === "string") return fires;
  if (!capturedTaskIds.boarding) return "boarding taskId was not captured";
  return fires.filter((fire) => fire.taskId === capturedTaskIds.boarding);
}

function captureBoarding(_status: number, body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.task)) {
    return `expected {task} response, saw ${JSON.stringify(body)}`;
  }
  const task = body.task;
  if (typeof task.taskId !== "string" || task.taskId.length === 0) {
    return `expected task.taskId string, saw ${JSON.stringify(task.taskId)}`;
  }
  capturedTaskIds.boarding = task.taskId;
  return undefined;
}

function assertRecoveryScheduled(
  _status: number,
  body: unknown,
): string | undefined {
  if (!isRecord(body) || !isRecord(body.task)) {
    return `expected {task} response from snooze, saw ${JSON.stringify(body)}`;
  }
  const task = body.task;
  if (task.taskId !== capturedTaskIds.boarding) {
    return `expected the boarding task, saw ${String(task.taskId)}`;
  }
  const state = isRecord(task.state) ? task.state : null;
  if (state?.status !== "scheduled") {
    return `expected the recovered reminder to stay scheduled, saw ${JSON.stringify(task.state)}`;
  }
  return undefined;
}

function assertNoStaleFire(_status: number, body: unknown): string | undefined {
  const fires = boardingFires(body);
  if (typeof fires === "string") return fires;
  const fired = fires.filter((f) => f.status === "fired");
  if (fired.length !== 0) {
    return `the boarding reminder must NOT fire at the stale original instant after the delay, saw ${JSON.stringify(fired)}`;
  }
  return undefined;
}

function assertRecoveredFire(
  _status: number,
  body: unknown,
): string | undefined {
  const fires = boardingFires(body);
  if (typeof fires === "string") return fires;
  if (fires.length !== 1) {
    return `expected exactly one recovered fire, saw ${JSON.stringify(fires)}`;
  }
  const fire = fires[0];
  if (fire?.status !== "fired" || fire.reason !== "scheduled_override_due") {
    return `expected fired(scheduled_override_due) at the recovered instant, saw ${JSON.stringify(fire)}`;
  }
  if (fire.occurrenceAtIso !== RECOVERED_INSTANT.toISOString()) {
    return `expected the recovered occurrence at ${RECOVERED_INSTANT.toISOString()}, saw ${fire.occurrenceAtIso}`;
  }
  return undefined;
}

export default scenario({
  // Literal (not the SCENARIO_ID const) so the static corpus guard can read it.
  id: "traveler-disruption-recovery-missed-connection",
  lane: "pr-deterministic",
  title:
    "Traveler disruption recovery: a delayed connection re-times the reminder, it never fires at the stale time",
  domain: "lifeops",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "traveler",
    "disruption",
    "personas",
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
      name: "register the always-delivering probe channel",
      apply: seedChannel,
    },
  ],
  rooms: [{ id: "main", source: "telegram", title: "Elena Road Recovery" }],
  turns: [
    {
      kind: "api",
      name: "create the original boarding reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "head to the gate for the connecting flight",
        trigger: { kind: "once", atIso: ORIGINAL_INSTANT.toISOString() },
        priority: "high",
        output: {
          destination: "channel",
          target: `${DELIVERY_CHANNEL_KIND}:owner`,
        },
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: SCENARIO_ID,
        ownerVisible: true,
        idempotencyKey: `${SCENARIO_ID}-boarding`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      captures: { boardingTaskId: "task.taskId" },
      assertResponse: captureBoarding,
    },
    {
      kind: "api",
      name: "the connection slips → re-time the reminder to the recovered instant",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:boardingTaskId}}/snooze",
      body: { untilIso: RECOVERED_INSTANT.toISOString() },
      expectedStatus: 200,
      assertResponse: assertRecoveryScheduled,
    },
    {
      kind: "tick",
      name: "tick at the ORIGINAL instant → no stale fire (the reminder was moved)",
      worker: "lifeops_scheduler",
      options: { now: ORIGINAL_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertNoStaleFire,
    },
    {
      kind: "tick",
      name: "tick at the RECOVERED instant → fires exactly once, recovered",
      worker: "lifeops_scheduler",
      options: { now: RECOVERED_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: assertRecoveredFire,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly one delivery — the recovered reminder, never the stale one",
      predicate: (): string | undefined => {
        if (deliveryLedger.length !== 1) {
          return `expected exactly 1 delivery (the recovered reminder), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
