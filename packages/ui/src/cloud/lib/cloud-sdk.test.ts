/** Verifies the actual SDK uses the canonical session transport and preserves request scope and payload. */
// @vitest-environment jsdom
import { AppBillingClient } from "@elizaos/cloud-sdk/app-billing";
import { expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() =>
  vi.fn(
    async (
      _path: string,
      _init: { body?: BodyInit | null; headers: Headers },
    ) => Response.json({ success: true, data: null }),
  ),
);
vi.mock("./api-client", () => ({ apiFetch }));

import { sessionCloudSdk } from "./cloud-sdk";

it("bridges SDK billing requests to the exact same-origin API path without another credential source", async () => {
  const client = new AppBillingClient(sessionCloudSdk.v1, "app-a", {
    clientId: "client-a",
  });
  await client.getCatalog();
  expect(apiFetch.mock.calls[0][0]).toBe(
    "/api/v1/apps/app-a/billing/catalog?clientId=client-a",
  );
  const command = {
    idempotencyKey: "intent-1",
    expectedSubscriptionRevision: null,
    planRevisionId: "plan-1",
    quantity: 2,
    billingConsent: "accepted" as const,
  };
  await client.createCheckout("account-1", "workspace", command);
  expect(apiFetch.mock.calls[1][0]).toBe(
    "/api/v1/apps/app-a/billing/accounts/account-1/subscriptions/workspace/checkout?clientId=client-a",
  );
  expect(JSON.parse(apiFetch.mock.calls[1][1].body as string)).toEqual(command);
  expect(apiFetch.mock.calls[1][1].headers.has("Authorization")).toBe(false);
});
