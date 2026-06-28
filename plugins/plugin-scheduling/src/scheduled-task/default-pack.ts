/**
 * Built-in generic fallback default-task pack.
 *
 * `@elizaos/plugin-scheduling` ships ZERO domain content — the rich first-run
 * pack (gm / gn / daily check-in / morning-brief watcher + a paused weekly
 * review) belongs to `@elizaos/plugin-personal-assistant`, the consumer. But PA
 * is not loaded on a stock mobile boot (it pulls `@elizaos/app-core`,
 * `@elizaos/agent`, `@elizaos/plugin-google`, and `@capacitor/core`), so on a
 * phone the scheduling spine + routes load with NO pack registered and the home
 * "Tasks" widget would have nothing to show.
 *
 * This module supplies a SMALL, generic fallback the spine seeds ONLY when no
 * consumer pack has registered (see `fallback: true` + the seeder's gate). When
 * PA is present its richer pack registers a non-fallback pack and this one is
 * skipped, so the two never double-seed. The wording is deliberately generic
 * (no PA-domain coupling) and the source is tagged `default_pack`.
 *
 * Pack contents (both `respectsGlobalPause: true`, `ownerVisible: true`):
 *   - **Good morning** — a `reminder` on a daily cron (08:00 local, UTC), so it
 *     ships RUNNING and the widget shows it on the running top-line.
 *   - **Weekly review** — a `recap` with a `manual` trigger, so it exists and
 *     is owner-visible but never fires on its own → ships PAUSED. A starter the
 *     owner can give a schedule or run on demand.
 *
 * The UI adapter (`packages/ui/src/utils/scheduled-task-to-automation.ts`) maps
 * `metadata.recordKey` → title and `trigger.kind === "manual"` → the paused
 * status, so these two records render as "Good morning" (active) and "Weekly
 * review" (paused) with no extra UI wiring.
 */

import type { DefaultTaskPack } from "./seed-registry.js";
import type { ScheduledTaskInput } from "./types.js";

/** Stable pack id + per-task idempotency keys for the built-in fallback. */
export const FALLBACK_DEFAULT_PACK_ID = "scheduling:built-in-fallback";

export const FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS = {
  goodMorning: "scheduling:default:gm",
  weeklyReview: "scheduling:default:weekly-review",
} as const;

/**
 * Build the built-in fallback pack. `createdBy` is the seeding agent so the
 * rows are attributed; everything else is fixed and generic.
 *
 * A daily 08:00 cron in UTC is intentional: the spine here has no OwnerFactStore
 * (that is PA's), so there is no per-user morning window to read. A fixed
 * generic time keeps the fallback honest — the owner can edit the time, give the
 * weekly review a schedule, or let PA's richer pack supersede this entirely.
 */
export function buildFallbackDefaultPack(opts: {
  agentId: string;
}): DefaultTaskPack {
  const { agentId } = opts;
  const tasks: ScheduledTaskInput[] = [
    {
      kind: "reminder",
      promptInstructions:
        "Wish the owner a warm good morning and surface anything pressing for the day.",
      trigger: { kind: "cron", expression: "0 8 * * *", tz: "UTC" },
      priority: "low",
      respectsGlobalPause: true,
      source: "default_pack",
      createdBy: agentId,
      ownerVisible: true,
      idempotencyKey: FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS.goodMorning,
      output: { destination: "channel", target: "in_app" },
      metadata: {
        defaultPack: "fallback",
        recordKey: "gm",
      },
    },
    {
      kind: "recap",
      promptInstructions:
        "Assemble a short weekly review for the owner: what got done, what slipped, and the two or three things worth focusing on next week. Keep it tight and end with one open question.",
      // Manual trigger = exists but never fires on its own → ships PAUSED on a
      // fresh install. The owner runs it on demand or gives it a schedule.
      trigger: { kind: "manual" },
      priority: "low",
      respectsGlobalPause: true,
      source: "default_pack",
      createdBy: agentId,
      ownerVisible: true,
      idempotencyKey: FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS.weeklyReview,
      output: { destination: "channel", target: "in_app" },
      metadata: {
        defaultPack: "fallback",
        recordKey: "weekly-review",
        pausedByDefault: true,
      },
    },
  ];

  return { id: FALLBACK_DEFAULT_PACK_ID, fallback: true, tasks };
}
