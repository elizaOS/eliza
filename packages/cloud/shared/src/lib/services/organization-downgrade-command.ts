/** Interactive original-quote confirmation. Started provider effects are recovered, never repeated. */
import type { OrganizationSubscriptionDowngradeCommandDto } from "@elizaos/cloud-sdk/contracts";
import { ElizaError } from "@elizaos/core";
import {
  type ConfirmOrganizationDowngradeInput,
  prepareOrganizationDowngrade,
} from "../../db/repositories/organization-downgrade-commands";
import {
  claimOrganizationSchedule,
  finishOrganizationScheduleAttempt,
  readOrganizationScheduleCommand,
} from "../../db/repositories/organization-schedule-effects";
import { logger } from "../utils/logger";
import {
  compensateOrganizationScheduleCreate,
  recoverOrganizationScheduleCompensation,
} from "./organization-schedule-compensation";
import {
  dispatchOrganizationScheduleConfiguration,
  prepareObservedOrganizationScheduleConfiguration,
} from "./organization-schedule-configuration";
import { recoverOriginalOrganizationScheduleCreate } from "./organization-schedule-create-recovery";
import { dispatchOrganizationScheduleCreate } from "./organization-schedule-dispatch";
import { observeAndFinalizeOrganizationScheduleConfiguration } from "./organization-schedule-publication";

type Identity = Parameters<typeof readOrganizationScheduleCommand>[0];
type Evidence = { kind: "event" | "response"; raw: unknown };
export function projectOrganizationSubscriptionDowngradeCommand(
  context: Awaited<ReturnType<typeof readOrganizationScheduleCommand>>,
): OrganizationSubscriptionDowngradeCommandDto {
  const c = context.command;
  if (
    !c.subscription_id ||
    c.expected_subscription_revision === null ||
    !["plus_monthly", "pro_monthly"].includes(c.target_plan_key ?? "") ||
    !["PREPARED", "OUTCOME_UNKNOWN", "APPLIED", "FAILED", "SUPERSEDED"].includes(c.status) ||
    (c.status === "APPLIED" && !c.organization_schedule_configuration_evidence)
  )
    throw new ElizaError("Organization downgrade status is unavailable", {
      code: "SUBSCRIPTION_DOWNGRADE_STATUS_UNAVAILABLE",
    });
  const effect =
    context.effects.find((e) => e.kind === "schedule_release") ??
    context.effects.find((e) => e.kind === "schedule_configure") ??
    context.effects.find((e) => e.kind === "schedule_create");
  return {
    commandId: c.id,
    subscriptionId: c.subscription_id,
    targetPlanKey: c.target_plan_key as "plus_monthly" | "pro_monthly",
    status: c.status as OrganizationSubscriptionDowngradeCommandDto["status"],
    expectedSubscriptionRevision: String(c.expected_subscription_revision),
    resultSubscriptionRevision:
      c.result_subscription_revision === null ? null : String(c.result_subscription_revision),
    effect: effect ? { kind: effect.kind, state: effect.state } : null,
    failure:
      c.status === "FAILED" || c.status === "SUPERSEDED"
        ? c.organization_schedule_failure_evidence
          ? "create_compensated"
          : "review_required"
        : null,
  };
}
export async function readOrganizationSubscriptionDowngrade(
  input: Identity,
  verifySession: () => Promise<void>,
) {
  const context = await readOrganizationScheduleCommand(input);
  await verifySession();
  return projectOrganizationSubscriptionDowngradeCommand(context);
}

/** This may dispatch a still-ready original effect only after renewed session/source/quote checks. */
export async function confirmOrganizationSubscriptionDowngrade(
  input: ConfirmOrganizationDowngradeInput,
  verifySession: () => Promise<void>,
) {
  let sessionFailure: unknown,
    sessionFailed = false;
  const verify = async () => {
    try {
      await verifySession();
    } catch (error) {
      // error-policy:J2 Preserve session loss after original-lease cleanup.
      sessionFailed = true;
      sessionFailure = error;
      throw error;
    }
  };
  await verify();
  const prepared = await prepareOrganizationDowngrade(input);
  const identity = {
    organizationId: input.organizationId,
    actorId: input.actorId,
    commandId: prepared.command.id,
  };
  const status = () => readOrganizationSubscriptionDowngrade(identity, verify);
  if (!["PREPARED", "OUTCOME_UNKNOWN"].includes(prepared.command.status)) return status();
  const attempt = await claimOrganizationSchedule(identity);
  if (!attempt) return status();
  const { claim, effect } = attempt;
  let createdEvidence: Evidence | undefined;
  try {
    if (effect.kind === "schedule_release") {
      if (effect.state === "ready") await compensateOrganizationScheduleCreate(identity, claim);
      else await recoverOrganizationScheduleCompensation(identity, claim);
    } else if (effect.kind === "schedule_configure" && effect.state !== "ready") {
      await observeAndFinalizeOrganizationScheduleConfiguration(identity, claim);
    } else {
      let configurationId = effect.kind === "schedule_configure" ? effect.id : null;
      if (effect.kind === "schedule_create") {
        if (effect.state === "ready") {
          if (!attempt.canDispatch)
            throw new ElizaError("Original review must be renewed before dispatch", {
              code: "SUBSCRIPTION_PLAN_CHANGE_CONFLICT",
            });
          createdEvidence = (
            await dispatchOrganizationScheduleCreate(identity, claim, effect.id, verify)
          ).evidence;
        } else createdEvidence = await recoverOriginalOrganizationScheduleCreate(identity, claim);
        configurationId = (
          await prepareObservedOrganizationScheduleConfiguration(
            identity,
            claim,
            effect.id,
            verify,
            createdEvidence,
          )
        ).id;
      }
      if (configurationId)
        await dispatchOrganizationScheduleConfiguration(
          identity,
          claim,
          configurationId,
          verify,
          createdEvidence,
        );
    }
  } catch (error) {
    // error-policy:J1 Only proven unconfigured creation may be compensated. Started
    // configuration/release is guarded by its journal and remains read-only recovery.
    try {
      await compensateOrganizationScheduleCreate(identity, claim, createdEvidence);
    } catch (cleanupError) {
      // error-policy:J1 Cleanup uncertainty is durable; never invent a terminal failure.
      logger.warn("[Organization Downgrade] Original cleanup remains unconfirmed", {
        commandId: identity.commandId,
        code: cleanupError instanceof ElizaError ? cleanupError.code : "PROVIDER_OUTCOME_UNKNOWN",
      });
    }
    logger.warn("[Organization Downgrade] Attempt remains unconfirmed", {
      commandId: identity.commandId,
      code: error instanceof ElizaError ? error.code : "PROVIDER_OUTCOME_UNKNOWN",
    });
  }
  try {
    await finishOrganizationScheduleAttempt(identity, claim);
  } catch (error) {
    // error-policy:J2 Authentication loss remains the response when lease cleanup
    // is unavailable; the original lease still expires durably.
    if (sessionFailed) {
      logger.warn("[Organization Downgrade] Lease cleanup unavailable after session loss", {
        commandId: identity.commandId,
      });
      throw sessionFailure;
    }
    throw new ElizaError("Downgrade attempt cleanup is unavailable", {
      code: "SUBSCRIPTION_DOWNGRADE_STATUS_UNAVAILABLE",
      cause: error,
    });
  }
  if (sessionFailed) throw sessionFailure;
  return status();
}
