/** Verifies durable billing recovery stays isolated between apps, buyers, accounts, and server-owned environments. */
// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  type BillingIntentScope,
  billingHostedUrl,
  readBillingIntent,
  writeBillingIntent,
} from "./billing-intent";

afterEach(() => sessionStorage.clear());
it("does not recover another app, account, user, client, or environment's command", () => {
  const scope: BillingIntentScope = {
    appId: "app-a",
    userId: "user-a",
    accountId: "account-a",
    clientId: "client-a",
    environment: "test",
    productFamilyKey: "workspace",
  };
  const pending = {
    intent: {
      kind: "portal" as const,
      request: {
        idempotencyKey: "stable-command",
        expectedSubscriptionRevision: "4",
      },
    },
    operationId: "operation-a",
  };
  writeBillingIntent(sessionStorage, scope, pending);
  expect(readBillingIntent(sessionStorage, scope)).toEqual(pending);
  for (const alternate of [
    { appId: "app-b" },
    { userId: "user-b" },
    { accountId: "account-b" },
    { clientId: "client-b" },
    { environment: "live" as const },
    { productFamilyKey: "research" },
  ])
    expect(
      readBillingIntent(sessionStorage, { ...scope, ...alternate }),
    ).toBeNull();
});
it("rejects script and credential-bearing hosted payment URLs", () => {
  expect(() => billingHostedUrl("javascript:alert(1)")).toThrow();
  expect(() =>
    billingHostedUrl("https://buyer:secret@payments.example"),
  ).toThrow();
});
