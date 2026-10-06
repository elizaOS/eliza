/** Shared migrated organization review fixture for real database lifecycle tests. */
import { readFile } from "node:fs/promises";
import {
  installCancellationTestSchema,
  seedCancellationTestAccount,
} from "./subscription-cancellation-test-fixture";
export async function installOrganizationUpgradeTestSchema(
  execute: (query: string) => Promise<unknown>,
  includeProviderBinding = true,
  includeRetainedTerms = true,
) {
  await installCancellationTestSchema(execute);
  for (const name of [
    "0511_organization_plan_change_quotes",
    "0512_organization_upgrade_dispatch",
    "0513_organization_upgrade_live_lease",
    ...(includeProviderBinding
      ? [
          "0514_organization_upgrade_quote_binding",
          "0515_organization_upgrade_invoice_origins",
          "0516_organization_upgrade_paid_finalization",
          "0517_organization_upgrade_historical_targets",
          "0518_organization_upgrade_historical_settlement",
          "0519_organization_upgrade_void_result",
          "0520_organization_downgrade_quotes",
          "0521_organization_schedule_effects",
          ...(includeRetainedTerms
            ? [
                "0522_organization_schedule_quote_terms",
                "0523_organization_schedule_compensation",
                "0524_organization_schedule_compensation_result",
                "0525_organization_schedule_configured_result",
                "0526_organization_schedule_configured_snapshot",
                "0527_organization_schedule_late_configuration",
              ]
            : []),
        ]
      : []),
  ]) {
    const migration = await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8");
    for (const q of migration.split("--> statement-breakpoint"))
      if (q.trim())
        await execute(
          q
            .replace(
              "ADD COLUMN organization_schedule_configuration_snapshot",
              "ADD COLUMN IF NOT EXISTS organization_schedule_configuration_snapshot",
            )
            .replace(
              "ADD COLUMN organization_schedule_configuration_evidence",
              "ADD COLUMN IF NOT EXISTS organization_schedule_configuration_evidence",
            )
            .replace(
              "ADD COLUMN organization_schedule_failure_evidence",
              "ADD COLUMN IF NOT EXISTS organization_schedule_failure_evidence",
            )
            .replace(
              "ADD COLUMN organization_upgrade_failure_evidence",
              "ADD COLUMN IF NOT EXISTS organization_upgrade_failure_evidence",
            )
            .replace(
              "ADD COLUMN organization_upgrade_settlement_evidence",
              "ADD COLUMN IF NOT EXISTS organization_upgrade_settlement_evidence",
            )
            .replace(
              "ADD COLUMN organization_upgrade_dispatch_state",
              "ADD COLUMN IF NOT EXISTS organization_upgrade_dispatch_state",
            ),
        );
  }
}
export async function seedOrganizationUpgradeTestAccount(
  queryOverride?: (text: string, values: unknown[]) => Promise<unknown>,
  period?: { start: Date; end: Date },
) {
  const f = await seedCancellationTestAccount(queryOverride, period);
  const authority = await import("./organization-plan-change");
  const captured = await authority.readOrganizationPlanChangeSource(f.input);
  const observedAt = new Date();
  const prorationDate = Math.floor(observedAt.getTime() / 1000);
  const micros =
    (65_000_000n * BigInt(f.source.current_period_end.getTime() - prorationDate * 1000)) /
    BigInt(f.source.current_period_end.getTime() - f.source.current_period_start.getTime());
  const invoice = {
    amountDueCents: 3500,
    subtotalCents: 3500,
    discountCents: 0,
    taxCents: 0,
    totalCents: 3500,
    startingBalanceCents: 0,
  };
  const review: import("../../lib/services/organization-plan-change-contract").OrganizationUpgradeReview =
    {
      kind: "upgrade_estimate",
      subscriptionId: f.input.subscriptionId,
      expectedSubscriptionRevision: "1",
      sourcePlanKey: "plus_monthly",
      targetPlanKey: "pro_monthly",
      catalogVersion: "v1",
      currency: "usd",
      prorationDate,
      currentPeriodStart: f.source.current_period_start.toISOString(),
      currentPeriodEnd: f.source.current_period_end.toISOString(),
      targetBaseAmountCents: 10000,
      targetAllowanceUsd: "90.000000",
      additionalAllowanceUsd: `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, "0")}`,
      dueNow: invoice,
      recurringEstimate: {
        ...invoice,
        amountDueCents: 10000,
        subtotalCents: 10000,
        totalCents: 10000,
      },
      observedAt: observedAt.toISOString(),
      expiresAt: new Date(
        Math.min(observedAt.getTime() + 60_000, f.source.current_period_end.getTime()),
      ).toISOString(),
    };
  const providerBinding: import("../../lib/services/organization-upgrade-provider-binding").OrganizationUpgradeProviderBinding =
    {
      sourcePriceId: "price_plus",
      targetPriceId: "price_pro",
      sourceProductId: "prod_plus",
      targetProductId: "prod_pro",
      livemode: false,
      apiVersion: "2024-11-20.acacia",
    };
  return { ...f, captured, review, providerBinding };
}
