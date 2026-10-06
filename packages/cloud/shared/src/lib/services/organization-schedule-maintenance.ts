/** Existing Stripe maintenance lane: original observation or proven partial-create cleanup only. */
import { ElizaError } from "@elizaos/core";
import {
  claimOrganizationSchedule,
  finishOrganizationScheduleAttempt,
  readOrganizationScheduleRecoveryCommand,
  readOrganizationScheduleRecoverySource,
} from "../../db/repositories/organization-schedule-effects";
import {
  listOrganizationScheduleRecovery,
  recordOrganizationScheduleRecoveryOutcome,
} from "../../db/repositories/organization-schedule-maintenance";
import {
  compensateOrganizationScheduleCreate,
  recoverOrganizationScheduleCompensation,
} from "./organization-schedule-compensation";
import { recoverOriginalOrganizationScheduleCreate } from "./organization-schedule-create-recovery";
import { observeAndFinalizeOrganizationScheduleConfiguration } from "./organization-schedule-publication";

type Identity = Parameters<typeof claimOrganizationSchedule>[0];
export async function reconcileOriginalOrganizationSchedule(identity: Identity) {
  const attempt = await claimOrganizationSchedule(identity, "recovery");
  if (!attempt) {
    const command = await readOrganizationScheduleRecoveryCommand(identity);
    return ["APPLIED", "FAILED", "SUPERSEDED"].includes(command.status)
      ? command.status
      : ("deferred" as const);
  }
  const { claim, effect } = attempt;
  try {
    if (effect.kind === "schedule_configure" && effect.state !== "ready")
      await observeAndFinalizeOrganizationScheduleConfiguration(identity, claim);
    else if (effect.kind === "schedule_release") {
      if (effect.state === "ready") await compensateOrganizationScheduleCreate(identity, claim);
      else await recoverOrganizationScheduleCompensation(identity, claim);
    } else if (!(effect.kind === "schedule_create" && effect.state === "ready")) {
      const context = await readOrganizationScheduleRecoverySource(identity, claim);
      // A still-valid review can resume only through interactive manager confirmation.
      if (context.reviewExpiresAt <= context.observedAt) {
        const evidence = await recoverOriginalOrganizationScheduleCreate(identity, claim);
        await compensateOrganizationScheduleCreate(identity, claim, evidence);
      }
    }
  } finally {
    await finishOrganizationScheduleAttempt(identity, claim);
  }
  return (await readOrganizationScheduleRecoveryCommand(identity)).status;
}
export async function recoverOrganizationSchedules(limit = 5) {
  const result = { inspected: 0, applied: 0, failed: 0, pending: 0, unavailable: 0, deferred: 0 };
  for (const command of await listOrganizationScheduleRecovery(limit)) {
    const identity = {
      organizationId: command.organization_id,
      actorId: command.requested_by_user_id,
      commandId: command.id,
    };
    result.inspected++;
    let status: Awaited<ReturnType<typeof reconcileOriginalOrganizationSchedule>>;
    try {
      status = await reconcileOriginalOrganizationSchedule(identity);
    } catch (error) {
      // error-policy:J4 Uncertainty is durable; failure to retain it fails the lane.
      const issueCode =
        error instanceof ElizaError && /^[A-Z][A-Z0-9_]{0,119}$/.test(error.code)
          ? error.code
          : "SCHEDULE_RECOVERY_UNAVAILABLE";
      await recordOrganizationScheduleRecoveryOutcome({ ...identity, issueCode });
      result.unavailable++;
      continue;
    }
    if (status === "APPLIED" || status === "FAILED" || status === "SUPERSEDED") {
      await recordOrganizationScheduleRecoveryOutcome({ ...identity, issueCode: null });
      if (status === "APPLIED") result.applied++;
      else result.failed++;
    } else if (status === "deferred") result.deferred++;
    else result.pending++;
  }
  return result;
}
