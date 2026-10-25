/** Retains target terms across demonstrated schedule lifecycle changes; this is never payment authority. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import {
  proveRetainedScheduleTargetPhase,
  readRetainedScheduleTarget,
} from "./organization-schedule-target-phase";
import { settlementDigest } from "./settlement-digest";

const timestamp = z.number().int().nonnegative().safe();
const terminal = z.object({
  status: z.enum(["released", "completed"]),
  current_phase: z.null(),
  subscription: z.string().nullable(),
  released_subscription: z.string().nullable(),
  released_at: timestamp.nullable(),
  completed_at: timestamp.nullable(),
  canceled_at: z.null(),
});
function reject(reason: string): never {
  throw new ElizaError("Original target schedule lifecycle is unverified", {
    code: "SUBSCRIPTION_SCHEDULE_TARGET_UNVERIFIED",
    context: { reason },
  });
}
export function proveRetainedScheduleTargetLifecycle(
  input: Parameters<typeof proveRetainedScheduleTargetPhase>[0],
) {
  const currentWire = z.record(z.string(), z.unknown()).parse(input.rawCurrentSchedule);
  if (currentWire.status === "active")
    return { ...proveRetainedScheduleTargetPhase(input), state: "active" as const };
  const target = readRetainedScheduleTarget(input),
    parsed = terminal.safeParse(currentWire);
  if (!parsed.success) reject("unsupported_terminal_schedule");
  const value = parsed.data,
    now = input.observedAt.getTime();
  if (!Number.isSafeInteger(now) || now < target.start.getTime()) reject("target_not_started");
  if (value.status === "released") {
    if (
      value.subscription !== null ||
      value.released_subscription !== input.subscriptionId ||
      value.completed_at !== null ||
      value.released_at === null ||
      value.released_at * 1000 < target.start.getTime() ||
      value.released_at * 1000 > now
    )
      reject("release_not_bound_to_original_target");
  } else if (
    value.released_at !== null ||
    value.completed_at === null ||
    value.completed_at * 1000 < target.end.getTime() ||
    value.completed_at * 1000 > now ||
    (value.subscription !== null && value.subscription !== input.subscriptionId) ||
    (value.released_subscription !== null && value.released_subscription !== input.subscriptionId)
  )
    reject("completion_not_bound_to_original_target");
  const originalWire = z.record(z.string(), z.unknown()).parse(input.originalSnapshot);
  for (const key of ["canceled_at", "completed_at", "released_at", "released_subscription"])
    if (originalWire[key] !== null) reject("original_lifecycle_not_active");
  const { lastResponse: _transport, ...currentSnapshot } = currentWire;
  // Compare every retained wire field. Only these validated lifecycle changes may differ;
  // the restored fields are a comparison projection, never a fabricated provider observation.
  const lifecycle = [
    "status",
    "current_phase",
    "subscription",
    "released_subscription",
    "released_at",
    "completed_at",
  ];
  const comparison = { ...currentSnapshot };
  for (const key of lifecycle) comparison[key] = originalWire[key];
  if (settlementDigest(comparison) !== input.originalSnapshotDigest)
    reject("terminal_schedule_terms_or_identity_changed");
  return {
    ...target,
    state: value.status,
    currentSnapshotDigest: settlementDigest(currentSnapshot),
  };
}
