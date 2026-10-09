/** Reads owner-scoped catalog, merchant readiness and recoverable administration operations from primary authority. */
import type {
  AppBillingAdministration,
  AppBillingAdminOperation,
  AppBillingAdminPlan,
  AppBillingMerchant,
} from "@elizaos/cloud-sdk/app-billing-admin";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { writeTransaction } from "../../db/helpers";
import {
  type AppBillingOwner,
  adminMerchant,
  adminMerchantDto,
  adminPlanDto,
  appBillingAdminFailure,
  lockAppBillingOwner,
} from "../../db/repositories/app-billing-admin";
import { appBillingPlanRevisions, billingMerchants } from "../../db/schemas/app-billing";
import { appClientRegistrations } from "../../db/schemas/app-delegations";
import {
  type BillingSubscriptionCommand,
  billingSubscriptionCommands,
} from "../../db/schemas/subscription-billing-operations";
export class GenericBillingAdminReadService {
  async overview(owner: AppBillingOwner): Promise<AppBillingAdministration> {
    return writeTransaction(async (tx) => {
      await lockAppBillingOwner(tx, owner);
      const registrations = await tx
        .select({
          id: appClientRegistrations.id,
          environment: appClientRegistrations.billing_environment,
          active: appClientRegistrations.is_active,
        })
        .from(appClientRegistrations)
        .where(
          and(
            eq(appClientRegistrations.app_id, owner.appId),
            eq(appClientRegistrations.owner_organization_id, owner.organizationId),
          ),
        );
      const merchantRows = await tx
        .select()
        .from(billingMerchants)
        .where(eq(billingMerchants.organization_id, owner.organizationId));
      const merchants: AppBillingMerchant[] = [];
      for (const row of merchantRows) merchants.push(await adminMerchantDto(tx, row));
      const planRows = await tx
        .select()
        .from(appBillingPlanRevisions)
        .where(eq(appBillingPlanRevisions.app_id, owner.appId))
        .orderBy(desc(appBillingPlanRevisions.created_at));
      const plans: AppBillingAdminPlan[] = [];
      for (const row of planRows) {
        const merchant = merchantRows.find((value) => value.id === row.merchant_id);
        if (!merchant)
          appBillingAdminFailure("Plan merchant ownership no longer matches this application");
        plans.push(await adminPlanDto(tx, row, merchant));
      }
      const commands = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.app_id, owner.appId),
            eq(billingSubscriptionCommands.organization_id, owner.organizationId),
            isNull(billingSubscriptionCommands.billing_scope_id),
            or(
              inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN"]),
              and(
                eq(billingSubscriptionCommands.status, "SUCCEEDED"),
                eq(billingSubscriptionCommands.kind, "merchant_onboarding"),
              ),
            ),
          ),
        )
        .orderBy(desc(billingSubscriptionCommands.created_at));
      const clock = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
      const databaseNow = new Date(clock.rows[0].now);
      const operations = commands
        .filter((command) => {
          if (command.status !== "SUCCEEDED") return true;
          const result = command.provider_result;
          const payload = command.request_payload;
          return (
            result?.kind === "merchant_onboarding" &&
            new Date(result.expiresAt) > databaseNow &&
            payload?.domain === "admin" &&
            payload.action === "merchant_onboarding" &&
            merchants.some(
              (merchant) =>
                merchant.id === payload.merchantId && merchant.connectionStatus !== "ready",
            )
          );
        })
        .map((command) => {
          const payload = command.request_payload;
          if (payload?.domain !== "admin")
            appBillingAdminFailure("Administration operation lacks immutable request authority");
          return {
            id: command.id,
            environment: command.livemode ? ("live" as const) : ("test" as const),
            clientRegistrationId: payload.clientRegistrationId,
            action: payload.action,
            status:
              command.status === "SUCCEEDED"
                ? ("requires_action" as const)
                : command.status === "PREPARED"
                  ? ("pending" as const)
                  : ("outcome_unknown" as const),
            createdAt: command.created_at.toISOString(),
          };
        });
      return { appId: owner.appId, registrations, merchants, plans, operations };
    });
  }
  async completed(
    owner: AppBillingOwner,
    command: BillingSubscriptionCommand,
  ): Promise<AppBillingAdminOperation> {
    return writeTransaction(async (tx) => {
      await lockAppBillingOwner(tx, owner);
      const result = command.provider_result;
      if (!result)
        appBillingAdminFailure("Completed administration operation has no durable provider result");
      if (result.kind === "merchant_onboarding") {
        const payload = command.request_payload;
        if (
          payload?.domain !== "admin" ||
          payload.action !== "merchant_onboarding" ||
          command.livemode === null
        )
          appBillingAdminFailure("Onboarding command lacks merchant authority");
        const merchant = await adminMerchantDto(
          tx,
          await adminMerchant(tx, owner, payload.merchantId, command.livemode),
        );
        const clock = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
        if (
          merchant.connectionStatus === "ready" ||
          new Date(result.expiresAt) <= new Date(clock.rows[0].now)
        )
          return { id: command.id, status: "succeeded", merchant, plan: null };
        return {
          id: command.id,
          status: "requires_action",
          action: { kind: "merchant_onboarding", url: result.url, expiresAt: result.expiresAt },
        };
      }
      if (result.kind === "merchant") {
        if (command.livemode === null) appBillingAdminFailure("Merchant result lacks environment");
        const merchant = await adminMerchant(tx, owner, result.merchantId, command.livemode);
        return {
          id: command.id,
          status: "succeeded",
          merchant: await adminMerchantDto(tx, merchant),
          plan: null,
        };
      }
      if (result.kind === "plan") {
        const [plan] = await tx
          .select()
          .from(appBillingPlanRevisions)
          .where(
            and(
              eq(appBillingPlanRevisions.id, result.planRevisionId),
              eq(appBillingPlanRevisions.app_id, owner.appId),
            ),
          );
        if (!plan || command.livemode === null)
          appBillingAdminFailure("Completed plan is unavailable");
        const merchant = await adminMerchant(tx, owner, plan.merchant_id, command.livemode);
        return {
          id: command.id,
          status: "succeeded",
          merchant: null,
          plan: await adminPlanDto(tx, plan, merchant),
        };
      }
      appBillingAdminFailure("Buyer result cannot complete an administration operation");
    });
  }
}
