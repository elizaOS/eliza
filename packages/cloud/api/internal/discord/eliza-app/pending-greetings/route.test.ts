/**
 * Exercises the internal pending-greeting HTTP boundary with mocked queue
 * storage while retaining real service authentication and request parsing.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const drain = mock(async () => [
  {
    sessionId: "platform:discord:123",
    platformUserId: "123",
    message: "you're all set",
    createdAt: new Date().toISOString(),
    deliveryNonce: "nonce-123",
    leaseId: "lease-123",
  },
]);
const acknowledge = mock(async () => 1);

mock.module("@/lib/services/eliza-app/onboarding-proactive-greeting", () => ({
  drainDiscordProactiveGreetings: drain,
  acknowledgeDiscordProactiveGreetings: acknowledge,
}));

const { default: app } = await import("./route");

function request(body: string, authorization = "Bearer test-secret") {
  return app.request(
    "http://localhost/",
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body,
    },
    { INTERNAL_SECRET: "test-secret" } as never,
  );
}

beforeEach(() => {
  drain.mockClear();
  acknowledge.mockClear();
});

describe("pending proactive greeting route", () => {
  test("requires internal service authentication", async () => {
    const response = await request(JSON.stringify({ action: "claim" }), "");
    expect(response.status).toBe(401);
    expect(drain).not.toHaveBeenCalled();
  });

  test("claims through the legacy empty body and explicit action", async () => {
    for (const body of [{}, { action: "claim" }]) {
      const response = await request(JSON.stringify(body));
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        greetings: Array<{ sessionId: string }>;
      };
      expect(payload.greetings.map((entry) => entry.sessionId)).toEqual([
        "platform:discord:123",
      ]);
    }
    expect(drain).toHaveBeenCalledTimes(2);
  });

  test("validates acknowledgements before crossing the storage boundary", async () => {
    const invalidBodies = [
      "not-json",
      JSON.stringify({ action: "unknown" }),
      JSON.stringify({ action: "ack", acknowledgements: "nope" }),
      JSON.stringify({
        action: "ack",
        acknowledgements: [{ sessionId: "short", leaseId: "lease" }],
      }),
    ];
    for (const body of invalidBodies) {
      expect((await request(body)).status).toBe(400);
    }
    expect(acknowledge).not.toHaveBeenCalled();

    const acknowledgements = [
      { sessionId: "platform:discord:123", leaseId: "lease-123" },
    ];
    const response = await request(
      JSON.stringify({ action: "ack", acknowledgements }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ acknowledged: 1 });
    expect(acknowledge).toHaveBeenCalledWith(acknowledgements);
  });
});
