/** Pure target-phase proof from a previously verified durable snapshot. Not payment or allowance authority. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { settlementDigest } from "./settlement-digest";

const seconds = z.number().int().nonnegative().safe();
const period = z.object({ start_date: seconds, end_date: seconds });
const schedule = z
  .object({
    id: z.string().regex(/^sub_sched_[A-Za-z0-9]+$/),
    object: z.literal("subscription_schedule"),
    customer: z.string().regex(/^cus_[A-Za-z0-9]+$/),
    subscription: z.string().regex(/^sub_[A-Za-z0-9]+$/),
    livemode: z.boolean(),
    status: z.literal("active"),
    end_behavior: z.literal("release"),
    current_phase: period,
    phases: z
      .array(
        period.extend({
          items: z.array(z.object({ price: z.string(), quantity: z.literal(1) })).length(1),
        }),
      )
      .length(2),
  })
  .passthrough();
function reject(reason: string): never {
  throw new ElizaError("Scheduled target phase is not the original configured target", {
    code: "SUBSCRIPTION_SCHEDULE_TARGET_UNVERIFIED",
    context: { reason },
  });
}
export function readRetainedScheduleTarget(input: {
  // All expectations and the original snapshot are loaded from immutable database-owned lineage.
  originalSnapshot: unknown;
  originalSnapshotDigest: string;
  scheduleId: string;
  customerId: string;
  subscriptionId: string;
  livemode: boolean;
  targetPriceId: string;
  effectiveAt: number;
}) {
  if (
    !/^[a-f0-9]{64}$/.test(input.originalSnapshotDigest) ||
    settlementDigest(input.originalSnapshot) !== input.originalSnapshotDigest
  )
    reject("original_snapshot_changed");
  const a = schedule.safeParse(input.originalSnapshot);
  if (!a.success) reject("unsupported_schedule_shape");
  const original = a.data,
    target = original.phases[1]!;
  if (
    original.id !== input.scheduleId ||
    original.customer !== input.customerId ||
    original.subscription !== input.subscriptionId ||
    original.livemode !== input.livemode ||
    target.start_date !== input.effectiveAt ||
    target.end_date <= target.start_date ||
    target.items[0]!.price !== input.targetPriceId ||
    original.current_phase.start_date !== original.phases[0]!.start_date ||
    original.current_phase.end_date !== target.start_date ||
    original.phases[0]!.end_date !== target.start_date
  )
    reject("original_target_binding_changed");
  const startMs = target.start_date * 1000,
    endMs = target.end_date * 1000;
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    !Number.isFinite(new Date(startMs).getTime()) ||
    !Number.isFinite(new Date(endMs).getTime())
  )
    reject("invalid_target_period");
  return {
    scheduleId: original.id,
    start: new Date(startMs),
    end: new Date(endMs),
    targetPriceId: input.targetPriceId,
    originalSnapshotDigest: input.originalSnapshotDigest,
  };
}

/** Adds fresh active-phase observation to the retained original target; this never grants allowance. */
export function proveRetainedScheduleTargetPhase(
  input: Parameters<typeof readRetainedScheduleTarget>[0] & {
    rawCurrentSchedule: unknown;
    observedAt: Date;
  },
) {
  const target = readRetainedScheduleTarget(input);
  const current = schedule.safeParse(input.rawCurrentSchedule);
  if (!current.success) reject("unsupported_schedule_shape");
  const observed = input.observedAt.getTime();
  if (
    !Number.isSafeInteger(observed) ||
    observed < target.start.getTime() ||
    observed >= target.end.getTime() ||
    current.data.current_phase.start_date * 1000 !== target.start.getTime() ||
    current.data.current_phase.end_date * 1000 !== target.end.getTime()
  )
    reject("current_target_period_required");
  const originalWire = z.record(z.string(), z.unknown()).parse(input.originalSnapshot);
  const { lastResponse: _transport, ...currentSnapshot } = z
    .record(z.string(), z.unknown())
    .parse(input.rawCurrentSchedule);
  if (
    settlementDigest({ ...currentSnapshot, current_phase: originalWire.current_phase }) !==
    input.originalSnapshotDigest
  )
    reject("configured_terms_or_identity_changed");
  return { ...target, currentSnapshotDigest: settlementDigest(currentSnapshot) };
}
