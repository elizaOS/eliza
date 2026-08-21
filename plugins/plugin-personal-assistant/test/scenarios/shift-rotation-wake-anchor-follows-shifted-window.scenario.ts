/**
 * B2 shift-rotation (pr-deterministic). Deterministic ScheduledTask proof that a
 * wake-anchored reminder for the rotating-shift persona (P3 marcus_shift) tracks
 * the shifted wake anchor rather than a fixed clock time: after the shift moves
 * his wake window to the afternoon, a `relative_to_anchor: wake.confirmed`
 * reminder fires relative to the NEW wake anchor and is silent at the old
 * morning wake slot. Drives the REAL scheduler tick (logical clock, no LLM, no
 * key) and asserts STRUCTURAL outcomes (dueness of the SAME anchored task at two
 * clock instants under the shifted owner facts), not routing. Maps to
 * LifeOpsBench shiftrotation.reanchor_recurring_reminders_to_new_shift; the live
 * conversational capture stays on the bench + live-only surface.
 *
 * The wake anchor's base is read LIVE from owner facts at every tick: `due.ts`
 * `resolveAnchorIso` resolves `wake.confirmed` to `ownerFacts.morningWindow.start`
 * per evaluation. With the post-rotation wake window seeded to 15:00, the
 * anchor+30m occurrence is 15:30. At the old morning wake slot (07:30) the
 * reminder is `anchor_pending` and does NOT fire; at 15:30 it FIRES exactly once.
 * Non-echo: the asserted tokens are fire STATUS, never text from a turn.
 *
 * Owner facts (timezone, morningWindow) are seeded through the REAL
 * OwnerFactStore. The task is created through the REAL REST surface. Delivery
 * goes through a scenario-registered always-delivering channel. Run keyless with
 * `TZ=UTC` so anchor math is unambiguous.
 *
 * Fail-without-fix anchors:
 *   - Make `relative_to_anchor` dueness read a persisted/cached anchor instead of
 *     resolving `wake.confirmed` from live owner facts in
 *     `plugins/plugin-scheduling/src/scheduled-task/due.ts` (`resolveAnchorIso`)
 *     and the reminder either fires at the stale 07:30 morning slot or never
 *     re-anchors to 15:30 — one of the two anchor turns fails.
 *   - Drop the `morningWindow.start` fallback for the `wake.confirmed` anchor and
 *     the anchor is unresolved (`anchor_unresolved`), so the 15:30 fire turn
 *     fails and nothing is delivered.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

const SCENARIO_ID = "shift-rotation-wake-anchor-follows-shifted-window";
const DELIVERY_CHANNEL_KIND = "scenario_shift_wake_anchor_delivery";

// ---------------------------------------------------------------------------
// Fixed logical clock, far in the future so ONLY the injected tick `now` decides
// dueness. UTC throughout. Post-rotation wake window starts at 15:00, so the
// wake.confirmed + 30m anchor lands at 15:30. 07:30 is the pre-rotation wake
// slot the reminder must NO LONGER fire on.
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

// 07:30 — the pre-rotation wake+offset slot; the reminder must not fire here now.
const OLD_WAKE_TICK = futureDateAtUtc(7, 30, 2);
// 15:30 — wake.confirmed(15:00) + 30m under the shifted wake window.
const NEW_WAKE_TICK = futureDateAtUtc(15, 30, 2);

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

const capturedTaskIds: { wakeReminder: string | null } = {
  wakeReminder: null,
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function seedFactsAndChannel(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  deliveryLedger.length = 0;
  capturedTaskIds.wakeReminder = null;
  const runtime = ctx.runtime as RuntimeLike;

  const registry = runtime.channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(DELIVERY_CHANNEL_KIND)) {
    registry.register({
      kind: DELIVERY_CHANNEL_KIND,
      describe: { label: "Scenario shift wake-anchor delivery probe" },
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
  // Post-rotation wake window in the afternoon: wake.confirmed resolves to 15:00.
  await store.update(
    {
      timezone: "UTC",
      morningWindow: { startLocal: "15:00", endLocal: "18:00" },
      eveningWindow: { startLocal: "23:00", endLocal: "05:00" },
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
      return `expected ${slot} NOT to fire at the old wake slot, saw ${JSON.stringify(fired)}`;
    }
    return undefined;
  };
}

export default scenario({
  id: "shift-rotation-wake-anchor-follows-shifted-window",
  lane: "pr-deterministic",
  title:
    "Wake-anchored reminder re-anchors to the shifted wake window and stays silent at the old morning slot",
  domain: "lifeops",
  evidenceScope: "domain-contract",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "lifeops",
    "shift-rotation",
    "personas",
    "scheduled-tasks",
    "12772",
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
      name: "seed post-rotation wake window (afternoon) and delivery channel",
      apply: seedFactsAndChannel,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Shift Rotation Wake Anchor",
    },
  ],
  turns: [
    // Wake-anchored reminder: 30 minutes after wake.confirmed. The anchor base is
    // resolved live from owner facts, so it follows the shifted wake window.
    {
      kind: "api",
      name: "create the wake.confirmed + 30m reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "just-after-wake shift routine reminder",
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
      assertResponse: captureTaskId("wakeReminder"),
    },
    // 07:30 — the pre-rotation wake+offset slot. Under the shifted wake window
    // the anchor is at 15:00, so the occurrence (15:30) is still pending: the
    // reminder must NOT fire at the old slot.
    {
      kind: "tick",
      name: "07:30 tick (old wake slot) → wake reminder silent (anchor pending)",
      worker: "lifeops_scheduler",
      options: { now: OLD_WAKE_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: notFiredFor("wakeReminder"),
    },
    // 15:30 — wake.confirmed(15:00) + 30m under the shifted wake window: the
    // reminder fires at its re-anchored instant.
    {
      kind: "tick",
      name: "15:30 tick (shifted wake + 30m) → wake reminder fires at its re-anchored instant",
      worker: "lifeops_scheduler",
      options: { now: NEW_WAKE_TICK.toISOString(), scheduledTaskLimit: 50 },
      assertResponse: firedFor("wakeReminder"),
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exactly one delivery — the wake reminder at the shifted anchor, none at the old slot",
      predicate: (): string | undefined => {
        // One delivery: the 15:30 re-anchored fire. A delivery at the 07:30 old
        // slot would push the count to two — the exact regression this scenario
        // guards (a wake reminder that ignores the shifted anchor).
        if (deliveryLedger.length !== 1) {
          return `expected exactly 1 delivery (the re-anchored wake reminder at 15:30; none at the old 07:30 slot), saw ${deliveryLedger.length}`;
        }
        return undefined;
      },
    },
  ],
});
