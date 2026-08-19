/** Tests authenticated platform-scoped greeting claim and acknowledgement. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const drain = mock(async () => [{ sessionId: "platform:telegram:123" }]);
const acknowledge = mock(async () => 1);
mock.module("@/lib/services/eliza-app/onboarding-proactive-greeting", () => ({
  drainProactiveGreetings: drain,
  acknowledgeProactiveGreetings: acknowledge,
}));
mock.module("../../../_auth", () => ({
  requireInternalAuth: mock(async () => ({ service: "webhook-gateway" })),
}));

const app = (await import("./route")).default;

beforeEach(() => {
  drain.mockClear();
  acknowledge.mockClear();
});

function request(body: unknown): Request {
  return new Request("https://cloud.test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("webhook proactive greeting route", () => {
  test("claims only an allowed webhook platform", async () => {
    const response = await app.request(
      request({ action: "claim", platform: "telegram" }),
    );
    expect(response.status).toBe(200);
    expect(drain).toHaveBeenCalledWith("telegram");

    const rejected = await app.request(
      request({ action: "claim", platform: "discord" }),
    );
    expect(rejected.status).toBe(400);

    const inAppRejected = await app.request(
      request({ action: "claim", platform: "in_app" }),
    );
    expect(inAppRejected.status).toBe(400);
  });

  test("acknowledges leases within the selected platform", async () => {
    const acknowledgements = [
      { sessionId: "platform:twilio:+14155550100", leaseId: "lease-1" },
    ];
    const response = await app.request(
      request({ action: "ack", platform: "twilio", acknowledgements }),
    );
    expect(response.status).toBe(200);
    expect(acknowledge).toHaveBeenCalledWith("twilio", acknowledgements);
  });
});
