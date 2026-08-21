/** Pins the subscription operation vocabulary and its tenant and state constraints. */
import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  BILLING_SUBSCRIPTION_COMMAND_KINDS,
  BILLING_SUBSCRIPTION_COMMAND_STATUSES,
  BILLING_SUBSCRIPTION_EVENT_RECEIPT_STATUSES,
  BILLING_SUBSCRIPTION_INCIDENT_KINDS,
  billingSubscriptionCommands,
  billingSubscriptionEventReceipts,
  billingSubscriptionIncidents,
  SUBSCRIPTION_BILLING_FENCE_STATES,
  subscriptionBillingFences,
} from "./subscription-billing-operations";

function checkNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).checks.map(({ name }) => name);
}

describe("subscription billing operation schema", () => {
  test("pins explicit command and recovery vocabularies", () => {
    expect(BILLING_SUBSCRIPTION_COMMAND_KINDS).toEqual([
      "upgrade",
      "downgrade",
      "cancel",
      "resume",
    ]);
    expect(BILLING_SUBSCRIPTION_COMMAND_STATUSES).toEqual([
      "queued",
      "processing",
      "provider_ambiguous",
      "succeeded",
      "failed",
      "superseded",
    ]);
    expect(SUBSCRIPTION_BILLING_FENCE_STATES).toEqual([
      "open",
      "deletion_requested",
      "provider_deleted",
      "released",
      "quarantined",
    ]);
    expect(BILLING_SUBSCRIPTION_EVENT_RECEIPT_STATUSES).toEqual([
      "received",
      "processing",
      "applied",
      "ignored",
      "failed",
      "quarantined",
    ]);
    expect(BILLING_SUBSCRIPTION_INCIDENT_KINDS).toContain("provider_timeout");
  });

  test("declares idempotency, provider fence, and terminal state checks", () => {
    expect(checkNames(billingSubscriptionCommands)).toEqual(
      expect.arrayContaining([
        "billing_subscription_commands_idempotency_check",
        "billing_subscription_commands_status_shape_check",
      ]),
    );
    expect(checkNames(subscriptionBillingFences)).toEqual(
      expect.arrayContaining([
        "subscription_billing_fences_provider_fence_check",
        "subscription_billing_fences_state_shape_check",
      ]),
    );
    expect(checkNames(billingSubscriptionEventReceipts)).toContain(
      "billing_subscription_event_receipts_status_shape_check",
    );
    expect(checkNames(billingSubscriptionIncidents)).toContain(
      "billing_subscription_incidents_resolution_shape_check",
    );
  });

  test("uses composite tenant foreign keys for every cross-table reference", () => {
    for (const table of [
      billingSubscriptionCommands,
      subscriptionBillingFences,
      billingSubscriptionEventReceipts,
      billingSubscriptionIncidents,
    ]) {
      const config = getTableConfig(table);
      expect(config.foreignKeys.some((key) => key.reference().columns.length > 1)).toBe(true);
    }
    expect(
      getTableConfig(billingSubscriptionIncidents).foreignKeys.map((key) => key.getName()),
    ).toEqual(
      expect.arrayContaining([
        "billing_subscription_incidents_subscription_tenant_fk",
        "billing_subscription_incidents_command_tenant_fk",
        "billing_subscription_incidents_receipt_tenant_fk",
      ]),
    );
  });
});
