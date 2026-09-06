/** Lists merchant-owned paid receipts and retrieves current refundable funds without issuing a provider mutation. Pagination preserves an explicit continuation through the same app and environment. */
import type {
  AppBillingPaidPeriods,
  AppBillingRefundPreview,
} from "@elizaos/cloud-sdk/app-billing-admin";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { z } from "zod";
import { writeTransaction } from "../../db/helpers";
import {
  type AppBillingOwner,
  adminRegistration,
  appBillingAdminFailure,
  lockAppBillingOwner,
} from "../../db/repositories/app-billing-admin";
import { appBillingProviderBindings } from "../../db/repositories/app-billing-provider-bindings";
import { lockAppBillingRefundSource } from "../../db/repositories/app-billing-refund-source";
import {
  appBillingAccounts,
  appBillingPlanRevisions,
  appBillingScopes,
  appSubscriptionPaidPeriods,
} from "../../db/schemas/app-billing";
import { billingSubscriptionCommands } from "../../db/schemas/subscription-billing-operations";
import { createGenericBillingProvider } from "./generic-billing-provider";
import { getAppBillingStripe } from "./generic-billing-runtime-config";
import { settlementDigest } from "./settlement-digest";

export const appBillingPaidPeriodsRequestSchema = z
  .object({
    clientRegistrationId: z.string().uuid(),
    cursor: z.string().uuid().nullable().default(null),
  })
  .strict();
export const appBillingRefundPreviewRequestSchema = z
  .object({ clientRegistrationId: z.string().uuid(), paidPeriodId: z.string().uuid() })
  .strict();

export class GenericBillingRefundReadService {
  constructor(
    private readonly stripeForMode: (livemode: boolean) => Promise<Stripe> = getAppBillingStripe,
  ) {}
  async paidPeriods(
    owner: AppBillingOwner,
    input: z.input<typeof appBillingPaidPeriodsRequestSchema>,
  ): Promise<AppBillingPaidPeriods> {
    const selection = appBillingPaidPeriodsRequestSchema.parse(input);
    return writeTransaction(async (tx) => {
      await lockAppBillingOwner(tx, owner);
      const registration = await adminRegistration(tx, owner, selection.clientRegistrationId);
      const scope = and(
        eq(appBillingScopes.app_id, owner.appId),
        eq(appBillingScopes.organization_id, owner.organizationId),
        eq(appBillingScopes.livemode, registration.billing_environment === "live"),
      );
      const [cursor] =
        selection.cursor === null
          ? []
          : await tx
              .select({
                id: appSubscriptionPaidPeriods.id,
              })
              .from(appSubscriptionPaidPeriods)
              .innerJoin(
                appBillingScopes,
                eq(appBillingScopes.id, appSubscriptionPaidPeriods.billing_scope_id),
              )
              .where(and(scope, eq(appSubscriptionPaidPeriods.id, selection.cursor)));
      if (selection.cursor !== null && !cursor)
        appBillingAdminFailure(
          "Receipt continuation is not owned by this app and environment",
          "FORBIDDEN",
        );
      const rows = await tx
        .select({
          id: appSubscriptionPaidPeriods.id,
          accountName: appBillingAccounts.display_name,
          planName: appBillingPlanRevisions.name,
          periodStart: appSubscriptionPaidPeriods.period_start,
          periodEnd: appSubscriptionPaidPeriods.period_end,
          quantity: appSubscriptionPaidPeriods.quantity,
        })
        .from(appSubscriptionPaidPeriods)
        .innerJoin(
          appBillingScopes,
          eq(appBillingScopes.id, appSubscriptionPaidPeriods.billing_scope_id),
        )
        .innerJoin(
          appBillingAccounts,
          eq(appBillingAccounts.id, appBillingScopes.billing_account_id),
        )
        .innerJoin(
          appBillingPlanRevisions,
          eq(appBillingPlanRevisions.id, appSubscriptionPaidPeriods.plan_revision_id),
        )
        .where(
          and(
            scope,
            cursor
              ? sql`(${appSubscriptionPaidPeriods.created_at},${appSubscriptionPaidPeriods.id}) < (SELECT created_at,id FROM app_subscription_paid_periods WHERE id=${cursor.id})`
              : undefined,
          ),
        )
        .orderBy(desc(appSubscriptionPaidPeriods.created_at), desc(appSubscriptionPaidPeriods.id))
        .limit(51);
      const hasMore = rows.length > 50;
      if (hasMore) rows.pop();
      const refunds =
        rows.length === 0
          ? []
          : await tx
              .select()
              .from(billingSubscriptionCommands)
              .where(
                and(
                  eq(billingSubscriptionCommands.app_id, owner.appId),
                  eq(billingSubscriptionCommands.organization_id, owner.organizationId),
                  eq(
                    billingSubscriptionCommands.livemode,
                    registration.billing_environment === "live",
                  ),
                  eq(billingSubscriptionCommands.kind, "refund"),
                  inArray(
                    sql<string>`${billingSubscriptionCommands.request_payload}->'source'->>'paidPeriodId'`,
                    rows.map((row) => row.id),
                  ),
                ),
              )
              .orderBy(desc(billingSubscriptionCommands.created_at));
      const last = rows.at(-1);
      return {
        appId: owner.appId,
        clientRegistrationId: registration.id,
        environment: registration.billing_environment,
        items: rows.map((row) => ({
          ...row,
          refundOperations: refunds
            .filter(
              (command) =>
                command.request_payload?.domain === "admin" &&
                command.request_payload.action === "refund" &&
                command.request_payload.source.paidPeriodId === row.id,
            )
            .map((command) => {
              const payload = command.request_payload;
              if (payload?.domain !== "admin" || payload.action !== "refund")
                appBillingAdminFailure("Refund history lacks its original request");
              const state =
                command.status === "PREPARED"
                  ? ("prepared" as const)
                  : command.status === "OUTCOME_UNKNOWN"
                    ? ("outcome_unknown" as const)
                    : command.status === "SUCCEEDED" && command.provider_result?.kind === "refund"
                      ? ("receipt_available" as const)
                      : command.status === "FAILED"
                        ? ("failed" as const)
                        : null;
              if (state === null)
                appBillingAdminFailure("Refund history has an unsupported execution state");
              return {
                id: command.id,
                amountCents: payload.amountCents,
                state,
                createdAt: command.created_at.toISOString(),
              };
            }),
          periodStart: row.periodStart.toISOString(),
          periodEnd: row.periodEnd.toISOString(),
        })),
        nextCursor: hasMore && last ? last.id : null,
      };
    });
  }
  async preview(
    owner: AppBillingOwner,
    input: z.input<typeof appBillingRefundPreviewRequestSchema>,
  ): Promise<AppBillingRefundPreview> {
    const selection = appBillingRefundPreviewRequestSchema.parse(input);
    const source = await writeTransaction((tx) => lockAppBillingRefundSource(tx, owner, selection));
    const provider = createGenericBillingProvider(
      await this.stripeForMode(source.merchant.livemode),
      source.merchant,
      appBillingProviderBindings,
    );
    const observed = await provider.previewRefund(source.scope, source.invoice);
    // Recheck current authorization after provider I/O before disclosing the payment details.
    const current = await writeTransaction((tx) =>
      lockAppBillingRefundSource(tx, owner, selection),
    );
    if (
      settlementDigest({
        merchant: current.merchant,
        scope: current.scope,
        invoice: current.invoice,
      }) !==
      settlementDigest({ merchant: source.merchant, scope: source.scope, invoice: source.invoice })
    )
      appBillingAdminFailure(
        "Payment ownership changed while refund details were retrieved",
        "FORBIDDEN",
      );
    return {
      appId: owner.appId,
      clientRegistrationId: selection.clientRegistrationId,
      paidPeriodId: source.paidPeriodId,
      environment: source.merchant.livemode ? "live" : "test",
      amountPaidCents: observed.value.amountPaidCents,
      amountAvailableCents: observed.value.amountAvailableCents,
      currency: observed.value.currency,
      accessPolicy: "preserve",
    };
  }
}
