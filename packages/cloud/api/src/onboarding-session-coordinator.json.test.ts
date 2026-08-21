/** Verifies the onboarding coordinator JSON boundary with deterministic service mocks. */
import { describe, expect, mock, test } from "bun:test";
import * as provisioningObservation from "../../shared/src/lib/services/eliza-app/provisioning-observation";

mock.module("../../shared/src/lib/cache/client", () => ({
  cache: {
    get: mock(async () => null),
    set: mock(async () => undefined),
  },
}));

mock.module("../../shared/src/lib/services/eliza-app/user-service", () => ({
  elizaAppUserService: {
    findOrCreateByPhone: mock(async () => ({ success: true })),
    linkPhoneToUser: mock(async () => ({ success: true })),
    linkDiscordToUser: mock(async () => ({ success: true })),
  },
}));

mock.module("../../shared/src/lib/services/eliza-app/provisioning", () => ({
  ...provisioningObservation,
  getElizaAppProvisioningStatus: mock(async () => ({
    status: "none",
    agentId: null,
    bridgeUrl: null,
    sandbox: null,
  })),
}));

const { OnboardingSessionCoordinator } = await import(
  "./onboarding-session-coordinator"
);

function coordinator(): InstanceType<typeof OnboardingSessionCoordinator> {
  return new OnboardingSessionCoordinator(
    { storage: {} } as unknown as DurableObjectState,
    {} as never,
  );
}

describe("onboarding session coordinator malformed JSON", () => {
  test("returns 400 instead of 500 on truncated JSON", async () => {
    const response = await coordinator().fetch(
      new Request("https://onboarding.test/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
  });

  test("does not relabel an internal SyntaxError as malformed request JSON", async () => {
    const instance = coordinator();
    const mutableInstance = instance as unknown as {
      runTurn: () => Promise<never>;
    };
    mutableInstance.runTurn = mock(async () => {
      throw new SyntaxError("internal parser failed");
    });

    const response = await instance.fetch(
      new Request("https://onboarding.test/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "platform:discord:user-1",
          input: { message: "hello" },
        }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: "internal parser failed",
    });
  });

  test("canonical JSON is still parsed and rejected as an invalid turn", async () => {
    const response = await coordinator().fetch(
      new Request("https://onboarding.test/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "platform:discord:user-1" }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid coordinator request",
    });
  });
});
