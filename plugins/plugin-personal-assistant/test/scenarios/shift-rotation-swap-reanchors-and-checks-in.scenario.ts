/**
 * B2 shift-rotation (live-only, tick-driving). A live-model journey for the
 * rotating-shift persona (P3 marcus_shift): mid-week he announces a swap onto
 * nights, and the assistant must (a) acknowledge the rotation in a gentle,
 * schedule-literate, non-nagging register, and (b) leave his shift-aware routines
 * re-anchored so the REAL scheduler fires them at the shifted waking window and
 * never inside his newly-protected daytime sleep. The conversational competence
 * is graded by a live judge; the scheduling outcome is proved STRUCTURALLY by a
 * real lifeops_scheduler tick reading `scheduledTaskFires[]`.
 *
 * The owner facts are seeded to the post-rotation (night) shift up front — the
 * scenario runner has no mid-run owner-fact mutation lever — so the tick outcome
 * reflects the rotated world the conversation is about. The habit reminder
 * (during_window: morning) is created through the REAL REST surface; its firing
 * window is read live from owner facts, so under the rotated facts it fires in
 * the afternoon waking window and stays silent at the pre-rotation morning slot,
 * which now falls inside protected sleep. Assertions are non-echo: the graded
 * tokens are the live judge's tone verdict and the derived fire STATUS, never
 * text copied from a turn.
 *
 * Live gate: this scenario needs a live model for the conversational turns; its
 * per-scenario live-model trajectory is the remaining evidence gate (captured
 * where model credentials are available, per AGENTS.md). The scheduling
 * mechanic it proves is also covered keyless by
 * shift-rotation-reanchor-protects-new-sleep-window.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "shift-rotation-swap-reanchors-and-checks-in";
const DELIVERY_CHANNEL_KIND = "scenario_shift_swap_delivery";

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

// 08:00 — the pre-rotation waking slot, now inside protected daytime sleep.
const OLD_MORNING_TICK = futureDateAtUtc(8, 0, 2);
// 15:30 — inside the shifted (post-rotation) waking window.
const NEW_MORNING_TICK = futureDateAtUtc(15, 30, 2);

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
const capturedTaskIds: { habit: string | null } = { habit: null };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedNightRotationFactsAndChannel(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.habit = null;
  const runtime = ctx.runtime as RuntimeLike;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario shift swap delivery probe" },
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
      morningWindow: { startLocal: "15:00", endLocal: "18:00" },
      eveningWindow: { startLocal: "23:00", endLocal: "05:00" },
      quietHours: { startLocal: "06:00", endLocal: "15:00", timezone: "UTC" },
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

function firesForHabit(body: unknown): FireEntry[] | string {
  const fires = readFires(body);
  if (typeof fires === "string") return fires;
  const taskId = capturedTaskIds.habit;
  if (typeof taskId !== "string" || taskId.length === 0) {
    return "captured habit taskId was not set by the create turn";
  }
  return fires.filter((fire) => fire.taskId === taskId);
}

function captureHabitId(_status: number, body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.task)) {
    return `expected {task} response, saw ${JSON.stringify(body)}`;
  }
  const task = body.task;
  if (typeof task.taskId !== "string" || task.taskId.length === 0) {
    return `expected task.taskId string, saw ${JSON.stringify(task.taskId)}`;
  }
  capturedTaskIds.habit = task.taskId;
  return undefined;
}

function habitSilentAtOldSlot(
  _status: number,
  body: unknown,
): string | undefined {
  const fires = firesForHabit(body);
  if (typeof fires === "string") return fires;
  const fired = fires.filter((f) => f.status === "fired");
  if (fired.length !== 0) {
    return `expected habit silent inside protected sleep, saw ${JSON.stringify(fired)}`;
  }
  return undefined;
}

function habitFiresAtShiftedWindow(
  _status: number,
  body: unknown,
): string | undefined {
  const fires = firesForHabit(body);
  if (typeof fires === "string") return fires;
  if (fires.length !== 1 || fires[0]?.status !== "fired") {
    return `expected exactly one habit fire at the shifted window, saw ${JSON.stringify(fires)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "shift-rotation-swap-reanchors-and-checks-in",
  title:
    "Shift swap onto nights: assistant checks in gently and the real scheduler re-anchors the routine to the shifted waking window",
  domain: "lifeops",
  tags: [
    "lifeops",
    "shift-rotation",
    "personas",
    "scheduled-tasks",
    "outcome",
    "12772",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: [
      "@elizaos/plugin-scheduling",
      "@elizaos/plugin-personal-assistant",
    ],
  },
  seed: [
    {
      type: "custom",
      name: "seed post-rotation (night) owner facts and delivery channel",
      apply: seedNightRotationFactsAndChannel,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "Shift Rotation Swap",
    },
  ],
  turns: [
    // Create the shift-aware habit through the REAL REST surface so the tick
    // outcome does not depend on the live model minting a scheduled task.
    {
      kind: "api",
      name: "seed the shift-aware morning habit reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "shift-routine habit tied to the waking window",
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
        idempotencyKey: `${SCENARIO_ID}-morning-habit`,
        metadata: { scenario: SCENARIO_ID },
      },
      expectedStatus: 201,
      assertResponse: captureHabitId,
    },
    // Live conversational turn: Marcus announces the swap onto nights. The
    // assistant must acknowledge the rotation in a schedule-literate register
    // and NOT ask him to re-enter his whole schedule or nag about being off
    // pattern.
    {
      kind: "message",
      name: "announce-shift-swap",
      room: "main",
      text: "Heads up — I got swapped onto nights starting this week, so my sleep is during the day now. How'd the switch go on your end — are my routines still lined up to my hours?",
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must acknowledge the rotation onto nights in a schedule-literate, non-judgmental register and confirm the routines move with his new hours. It must NOT ask him to re-enter his whole schedule from scratch, and it must NOT scold or comment on his sleep being 'off schedule' or irregular. A generic reply that ignores the shift, or one that nags about the daytime sleep, fails.",
      },
    },
    // Tick at the pre-rotation morning slot — now inside protected daytime sleep:
    // the habit must stay silent.
    {
      kind: "tick",
      name: "08:00 tick (pre-rotation slot, now protected sleep) → habit silent",
      worker: "lifeops_scheduler",
      options: { now: OLD_MORNING_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: habitSilentAtOldSlot,
    },
    // Tick at the shifted waking window: the habit fires at its re-anchored slot.
    {
      kind: "tick",
      name: "15:30 tick (shifted waking window) → habit fires at its re-anchored window",
      worker: "lifeops_scheduler",
      options: { now: NEW_MORNING_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: habitFiresAtShiftedWindow,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "the routine delivered only at the shifted waking window, never inside protected sleep",
      predicate: (): string | undefined => {
        // Exactly one habit delivery, from the 15:30 shifted-window fire. A
        // second delivery would mean the habit fired at the 08:00 protected-sleep
        // tick — the re-anchor regression this scenario guards. Zero would mean
        // the routine silently stopped following his shift.
        if (deliveryLedger.length !== 1) {
          return `expected exactly 1 routine delivery (at the shifted waking window; none inside protected sleep), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 1,
    },
    {
      type: "judgeRubric",
      name: "shift-swap-checkin-tone",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the assistant acknowledged the rotation onto nights without asking Marcus to re-enter his schedule and without shaming his daytime sleep, and his routine remained anchored to his new waking hours rather than his old ones.",
    },
  ],
});
