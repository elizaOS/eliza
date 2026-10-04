/** Shared migrated organization review fixture for real database lifecycle tests. */
import { readFile } from "node:fs/promises";
import {
  installCancellationTestSchema,
  seedCancellationTestAccount,
} from "./subscription-cancellation-test-fixture";
export async function installOrganizationUpgradeTestSchema(
  execute: (query: string) => Promise<unknown>,
) {
  await installCancellationTestSchema(execute);
  for (const name of [
    "0511_organization_plan_change_quotes",
    "0512_organization_upgrade_dispatch",
  ]) {
    const migration = await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8");
    for (const q of migration.split("--> statement-breakpoint")) if (q.trim()) await execute(q);
  }
}
export async function seedOrganizationUpgradeTestAccount(
  queryOverride?: (text: string, values: unknown[]) => Promise<unknown>,
) {
  const f = await seedCancellationTestAccount(queryOverride);
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
      expiresAt: new Date(observedAt.getTime() + 60_000).toISOString(),
    };
  return { ...f, captured, review };
}
