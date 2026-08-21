/**
 * Pins the server-owned recurring-billing persistence vocabulary and the
 * database constraints that keep allowance separate from purchased credits.
 */
import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  BILLING_FUNDING_CLASSES,
  BILLING_FUNDING_RESERVATION_PHASES,
  BILLING_FUNDING_RESERVATION_STATUSES,
  billingFundingReservations,
} from "./billing-funding-reservations";
import {
  BILLING_SUBSCRIPTION_STATUSES,
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "./billing-subscriptions";
import {
  ORGANIZATION_ENTITLEMENT_STATES,
  organizationEntitlements,
} from "./organization-entitlements";
import { organizations } from "./organizations";
import {
  SUBSCRIPTION_ALLOWANCE_PERIOD_STATES,
  subscriptionAllowancePeriods,
} from "./subscription-allowance-periods";
import {
  SUBSCRIPTION_ALLOWANCE_TRANSACTION_KINDS,
  subscriptionAllowanceTransactions,
} from "./subscription-allowance-transactions";

function checkNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).checks.map((constraint) => constraint.name);
}

describe("subscription persistence schema", () => {
  test("excludes trials and exposes explicit dunning lifecycle states", () => {
    expect(BILLING_SUBSCRIPTION_STATUSES).toEqual([
      "pending",
      "active",
      "grace",
      "past_due",
      "unpaid",
      "canceled",
      "incomplete_expired",
    ]);
    expect(ORGANIZATION_ENTITLEMENT_STATES).toEqual([
      "free",
      "active",
      "grace",
      "past_due",
      "unpaid",
    ]);
    expect(checkNames(billingSubscriptions)).toContain(
      "billing_subscriptions_provider_fence_check",
    );
    expect(checkNames(billingSubscriptionRevisions)).toContain(
      "billing_subscription_revisions_provider_fence_check",
    );
  });

  test("keeps entitlement authority rebuildable and source-fenced", () => {
    const config = getTableConfig(organizationEntitlements);
    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "catalog_version",
        "projection_revision",
        "source_digest",
        "source_subscription_id",
        "source_subscription_revision",
        "rebuilt_at",
      ]),
    );
    expect(checkNames(organizationEntitlements)).toContain(
      "organization_entitlements_plan_state_check",
    );
  });

  test("makes allowance non-rollover and fully auditable", () => {
    expect(SUBSCRIPTION_ALLOWANCE_PERIOD_STATES).toEqual([
      "open",
      "expired",
      "clawed_back",
      "closed",
    ]);
    expect(SUBSCRIPTION_ALLOWANCE_TRANSACTION_KINDS).toEqual([
      "grant",
      "reserve",
      "settle",
      "refund",
      "expire",
      "clawback",
      "grant_adjustment",
      "close",
    ]);
    expect(checkNames(subscriptionAllowancePeriods)).toEqual(
      expect.arrayContaining([
        "subscription_allowance_periods_period_check",
        "subscription_allowance_periods_amounts_check",
        "subscription_allowance_periods_terminal_amounts_check",
      ]),
    );
    const transactionConfig = getTableConfig(subscriptionAllowanceTransactions);
    expect(transactionConfig.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "sequence",
        "remaining_before",
        "remaining_after",
        "expired_before",
        "expired_after",
        "clawed_back_before",
        "clawed_back_after",
        "source_subscription_id",
        "source_subscription_revision",
        "source_invoice_id",
        "source_plan_key",
        "source_catalog_version",
      ]),
    );
    expect(checkNames(subscriptionAllowanceTransactions)).toContain(
      "subscription_allowance_transactions_snapshot_transition_check",
    );
  });

  test("records exact allowance and purchased-credit funding splits", () => {
    expect(BILLING_FUNDING_CLASSES).toEqual(["allowance_eligible", "cash_only"]);
    expect(BILLING_FUNDING_RESERVATION_PHASES).toEqual(["initial", "overage"]);
    expect(BILLING_FUNDING_RESERVATION_STATUSES).toEqual([
      "reserved",
      "settled",
      "partially_refunded",
      "refunded",
    ]);
    expect(checkNames(billingFundingReservations)).toEqual(
      expect.arrayContaining([
        "billing_funding_reservations_allocation_check",
        "billing_funding_reservations_settlement_amounts_check",
        "billing_funding_reservations_credit_reference_check",
        "billing_funding_reservations_terminal_shape_check",
        "billing_funding_reservations_phase_shape_check",
      ]),
    );
    expect(getTableConfig(billingFundingReservations).columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "reservation_phase",
        "phase_sequence",
        "parent_reservation_id",
        "root_reservation_id",
      ]),
    );
    expect(getTableConfig(organizations).columns.map(({ name }) => name)).toContain(
      "spendable_revision",
    );
  });
});
