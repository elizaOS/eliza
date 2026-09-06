/** Exercises callback authentication with real HMAC implementations and adversarial transport inputs. */

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  type AppBillingNotification,
  createAppNotificationSignature,
  verifyAppBillingNotification,
} from "./app-notifications.js";

const secret = "test-only-notification-key-for-real-crypto";
const timestamp = "2026-09-05T12:00:00.000Z";
const event: AppBillingNotification = {
  version: 1,
  id: "e3ccfe51-a7f8-4378-98e1-64d509402403",
  event: "app.subscription.updated",
  appId: "5e034e80-8b99-44b9-bbe4-2a59d63045f1",
  environment: "test",
  billingAccountId: "881ffb8c-8f29-4e8b-a7ea-cc745b8f9120",
  productFamilyKey: "workspace",
  subscriptionRevision: "12",
  occurredAt: timestamp,
};

function request(body = JSON.stringify(event)) {
  return {
    secret,
    expectedAppId: event.appId,
    expectedEnvironment: event.environment,
    timestamp,
    body,
    signature: `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`,
    now: new Date(timestamp),
  };
}

describe("signed app billing callbacks", () => {
  test("verifies the existing callback wire protocol across crypto implementations", async () => {
    const input = request();
    const result = await verifyAppBillingNotification(input);
    expect(result.id).toBe(event.id);
    expect(result.subscriptionRevision).toBe("12");
    const signature = await createAppNotificationSignature(
      secret,
      timestamp,
      input.body,
    );
    expect(signature).toBe(input.signature);
  });

  test("rejects a modified subscription revision or whitespace in signed body bytes", async () => {
    const input = request();
    input.body = JSON.stringify({ ...event, subscriptionRevision: "13" });
    await expect(verifyAppBillingNotification(input)).rejects.toThrow(
      "signature is invalid",
    );
    input.body = ` ${JSON.stringify(event)}`;
    await expect(verifyAppBillingNotification(input)).rejects.toThrow(
      "signature is invalid",
    );
  });

  test("rejects a signature from another app's signing key", async () => {
    await expect(
      verifyAppBillingNotification({
        ...request(),
        secret: "different-app-signing-key",
      }),
    ).rejects.toThrow("signature is invalid");
  });

  test("rejects a valid callback delivered to another app", async () => {
    await expect(
      verifyAppBillingNotification({
        ...request(),
        expectedAppId: "e419cddf-dd97-4677-ac82-ee520f721ae2",
      }),
    ).rejects.toThrow("different app");
  });

  test("a sandbox callback cannot authorize a production consumer", async () => {
    await expect(
      verifyAppBillingNotification({
        ...request(),
        expectedEnvironment: "live",
      }),
    ).rejects.toThrow("different billing environment");
  });

  test("rejects replayed or future timestamps beyond the receiver's clock tolerance", async () => {
    for (const offset of [-301_000, 301_000]) {
      await expect(
        verifyAppBillingNotification({
          ...request(),
          now: new Date(Date.parse(timestamp) + offset),
        }),
      ).rejects.toThrow("expired");
    }
    await expect(
      verifyAppBillingNotification({
        ...request(),
        timestamp: "2026-09-05T12:01:00.000Z",
      }),
    ).rejects.toThrow("signature is invalid");
  });

  test("rejects malformed signed content instead of manufacturing an event", async () => {
    await expect(verifyAppBillingNotification(request("{"))).rejects.toThrow(
      "not valid JSON",
    );
    await expect(
      verifyAppBillingNotification(
        request(JSON.stringify({ ...event, subscriptionRevision: 12 })),
      ),
    ).rejects.toThrow("billing contract");
    await expect(
      verifyAppBillingNotification(
        request(JSON.stringify({ ...event, occurredAt: "not-a-date" })),
      ),
    ).rejects.toThrow("billing contract");
  });
});
