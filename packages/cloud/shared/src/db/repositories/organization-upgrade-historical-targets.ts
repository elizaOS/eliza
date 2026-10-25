/** Retains authenticated historical evidence under organization locks; grants no current authority. */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import { organizationUpgradeReviewSchema } from "../../lib/services/organization-plan-change-contract";
import { projectHistoricalUpgradeTarget } from "../../lib/services/organization-upgrade-historical-target";
import { isUniqueConstraintError } from "../../lib/utils/db-errors";
import { writeTransaction } from "../helpers";
import { organizationUpgradeHistoricalTargets as targets } from "../schemas/organization-upgrade-historical-targets";
import { organizations } from "../schemas/organizations";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";
import { readOrganizationUpgradeRecoveryContext } from "./organization-upgrade-recovery-context";
import { readPostLockDatabaseNow } from "./primary-database-clock";

function reject(reason: string): never {
  throw new ElizaError("Historical upgrade evidence conflicts with original authority", {
    code: "SUBSCRIPTION_UPGRADE_HISTORICAL_TARGET_CONFLICT",
    context: { reason },
  });
}
/** Only a verified platform webhook or authenticated Stripe event read may call this boundary. */
export async function recordOrganizationUpgradeHistoricalTarget(input: {
  organizationId: string;
  commandId: string;
  raw: unknown;
}) {
  try {
    return await writeTransaction(async (tx) => {
      const [org] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .for("update");
      if (!org) reject("organization_unavailable");
      const [locked] = await tx
        .select({ id: commands.id })
        .from(commands)
        .where(
          and(eq(commands.id, input.commandId), eq(commands.organization_id, input.organizationId)),
        )
        .for("update");
      if (!locked) reject("command_unavailable");
      const context = await readOrganizationUpgradeRecoveryContext(input, tx);
      const origin = context.origin;
      if (!origin) reject("original_invoice_unavailable");
      const historical = context.historicalSource;
      const source = {
        ...historical,
        id: historical.subscription_id,
        lifecycle_revision: historical.revision,
      };
      const now = await readPostLockDatabaseNow(tx);
      const evidence = projectHistoricalUpgradeTarget({
        source,
        review: organizationUpgradeReviewSchema.parse(context.quote.review),
        binding: context.binding,
        raw: input.raw,
        observedAt: now,
        origin: {
          invoiceId: origin.invoice_id,
          customerId: origin.customer_id,
          subscriptionId: origin.subscription_id,
          livemode: origin.livemode,
          invoiceCreatedAt: origin.invoice_created_at,
        },
      });
      const [existing] = await tx
        .select()
        .from(targets)
        .where(
          and(
            eq(targets.command_id, input.commandId),
            eq(targets.organization_id, input.organizationId),
          ),
        );
      if (existing) {
        if (
          existing.provider_event_id === evidence.eventId &&
          existing.evidence_digest !== evidence.eventDigest
        )
          reject("conflicting_event_replay");
        // Another independently validated event does not replace the first immutable target evidence.
        return { receipt: existing, created: false };
      }
      const [receipt] = await tx
        .insert(targets)
        .values({
          command_id: input.commandId,
          organization_id: input.organizationId,
          provider_event_id: evidence.eventId,
          event_type: evidence.eventType,
          api_version: evidence.apiVersion,
          livemode: origin.livemode,
          invoice_id: origin.invoice_id,
          event_created_at: evidence.eventCreatedAt,
          observed_at: now,
          evidence_digest: evidence.eventDigest,
          raw_subscription: evidence.rawSubscription,
        })
        .returning();
      if (!receipt) reject("receipt_not_saved");
      return { receipt, created: true };
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) reject("event_already_attributed");
    throw error;
  }
}
