/** Retains authenticated request attribution after dispatch, including late recovery. No entitlement writes. */
import { ElizaError } from "@elizaos/core";
import { and, eq, isNull } from "drizzle-orm";
import { organizationUpgradeReviewSchema } from "../../lib/services/organization-plan-change-contract";
import {
  projectAuthenticatedUpgradeInvoiceOrigin,
  projectOriginalUpgradeResponseInvoiceOrigin,
} from "../../lib/services/organization-upgrade-invoice-origin";
import {
  organizationUpgradeIntentDigest,
  organizationUpgradeProviderBindingSchema,
} from "../../lib/services/organization-upgrade-provider-binding";
import { settlementDigest } from "../../lib/services/settlement-digest";
import { isUniqueConstraintError } from "../../lib/utils/db-errors";
import { writeTransaction } from "../helpers";
import { billingSubscriptionRevisions } from "../schemas/billing-subscriptions";
import { organizationPlanChangeQuotes } from "../schemas/organization-plan-change-quotes";
import { organizationUpgradeInvoiceOrigins as origins } from "../schemas/organization-upgrade-invoice-origins";
import { organizations } from "../schemas/organizations";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";
import { readPostLockDatabaseNow } from "./primary-database-clock";

function reject(reason: string): never {
  throw new ElizaError(
    "Organization upgrade invoice attribution requires its original dispatched command",
    {
      code: "SUBSCRIPTION_UPGRADE_INVOICE_ORIGIN_CONFLICT",
      context: { reason },
    },
  );
}
/** Internal authenticated provider boundary, never an HTTP input DTO.
 * Financial evidence can arrive after actor removal/lease/period expiry. Retaining
 * it grants no dispatch, subscription transition, or allowance authority.
 */
export async function recordOrganizationUpgradeInvoiceOrigin(input: {
  organizationId: string;
  commandId: string;
  evidence: { kind: "invoice_created_event" | "update_response"; raw: unknown };
}) {
  try {
    return await writeTransaction(async (tx) => {
      const [org] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .for("update");
      if (!org) reject("organization_unavailable");
      const [command] = await tx
        .select()
        .from(commands)
        .where(
          and(
            eq(commands.id, input.commandId),
            eq(commands.organization_id, input.organizationId),
            isNull(commands.app_id),
            isNull(commands.billing_scope_id),
          ),
        )
        .for("update");
      if (
        !command ||
        command.kind !== "upgrade" ||
        command.merchant_key !== "platform" ||
        command.organization_upgrade_dispatch_state !== "started" ||
        !command.subscription_id ||
        command.expected_subscription_revision === null
      )
        reject("original_dispatch_unavailable");
      const [quote] = await tx
        .select()
        .from(organizationPlanChangeQuotes)
        .where(
          and(
            eq(organizationPlanChangeQuotes.consumed_by_command_id, command.id),
            eq(organizationPlanChangeQuotes.organization_id, input.organizationId),
          ),
        )
        .for("update");
      if (
        !quote ||
        quote.actor_id !== command.requested_by_user_id ||
        quote.subscription_id !== command.subscription_id ||
        quote.subscription_revision !== command.expected_subscription_revision ||
        quote.target_plan_key !== command.target_plan_key ||
        quote.review_digest !== settlementDigest(quote.review) ||
        command.request_digest !==
          organizationUpgradeIntentDigest({
            organizationId: input.organizationId,
            actorId: command.requested_by_user_id,
            quoteId: quote.id,
            reviewDigest: quote.review_digest,
            sourceDigest: quote.source_digest,
            providerBinding: quote.provider_binding,
          })
      )
        reject("original_quote_unavailable");
      const binding = organizationUpgradeProviderBindingSchema.parse(quote.provider_binding);
      const review = organizationUpgradeReviewSchema.parse(quote.review);
      const [source] = await tx
        .select()
        .from(billingSubscriptionRevisions)
        .where(
          and(
            eq(billingSubscriptionRevisions.organization_id, input.organizationId),
            eq(billingSubscriptionRevisions.subscription_id, command.subscription_id),
            eq(billingSubscriptionRevisions.revision, command.expected_subscription_revision),
          ),
        );
      if (
        !source ||
        source.billing_scope_id !== null ||
        source.merchant_key !== "platform" ||
        source.provider !== "stripe" ||
        binding.livemode !== (source.provider_environment === "live")
      )
        reject("historical_source_unavailable");
      const now = await readPostLockDatabaseNow(tx);
      const project =
        input.evidence.kind === "invoice_created_event"
          ? projectAuthenticatedUpgradeInvoiceOrigin
          : projectOriginalUpgradeResponseInvoiceOrigin;
      const observation = project({
        raw: input.evidence.raw,
        originalRequest: {
          providerIdempotencyKey: command.provider_idempotency_key,
          customerId: source.stripe_customer_id,
          subscriptionId: source.stripe_subscription_id,
          livemode: binding.livemode,
          prorationDate: review.prorationDate,
        },
        observedAt: now,
      });
      const [existing] = await tx
        .select()
        .from(origins)
        .where(
          and(
            eq(origins.command_id, command.id),
            eq(origins.organization_id, input.organizationId),
          ),
        );
      if (existing) {
        if (
          existing.provider_request_id !== observation.providerRequestId ||
          existing.provider_idempotency_key !== observation.providerIdempotencyKey ||
          existing.customer_id !== observation.customerId ||
          existing.subscription_id !== observation.subscriptionId ||
          existing.livemode !== observation.livemode ||
          existing.invoice_id !== observation.invoiceId
        )
          reject("conflicting_original_invoice");
        return { receipt: existing, created: false };
      }
      if (command.status !== "OUTCOME_UNKNOWN") reject("command_not_reconcilable");
      const [receipt] = await tx
        .insert(origins)
        .values({
          command_id: command.id,
          organization_id: input.organizationId,
          invoice_id: observation.invoiceId,
          evidence_kind: observation.kind,
          provider_event_id: observation.eventId,
          provider_request_id: observation.providerRequestId,
          provider_idempotency_key: observation.providerIdempotencyKey,
          customer_id: observation.customerId,
          subscription_id: observation.subscriptionId,
          livemode: observation.livemode,
          api_version: observation.apiVersion,
          invoice_created_at: new Date(observation.invoiceCreatedAt),
          event_created_at:
            observation.eventCreatedAt === null ? null : new Date(observation.eventCreatedAt),
          observed_at: now,
          evidence_digest: observation.evidenceDigest,
          created_at: now,
        })
        .returning();
      if (!receipt) reject("receipt_not_saved");
      return { receipt, created: true };
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) reject("invoice_already_attributed");
    throw error;
  }
}
