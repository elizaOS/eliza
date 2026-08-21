import { describe, expect, test } from "bun:test";

type DurableObjectExport = {
  type?: string;
  storage?: string;
};

describe("Durable Object deployment contract", () => {
  test("declares every live class without replaying legacy migrations", async () => {
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
    ) as {
      exports?: Record<string, DurableObjectExport>;
      migrations?: unknown;
    };

    expect(config.migrations).toBeUndefined();
    expect(config.exports).toEqual({
      AnonymousChatGate: { type: "durable-object", storage: "sqlite" },
      InferenceAdmissionGate: { type: "durable-object", storage: "sqlite" },
      InferenceRateLimitV2RollbackFloor: {
        type: "durable-object",
        storage: "sqlite",
      },
      OnboardingSessionCoordinator: {
        type: "durable-object",
        storage: "sqlite",
      },
      PersonalDeliveryProjection: {
        type: "durable-object",
        storage: "sqlite",
      },
      PersonalTelegramDelivery: {
        type: "durable-object",
        storage: "sqlite",
      },
      SharedRuntimeConversation: {
        type: "durable-object",
        storage: "sqlite",
      },
      TwitterOAuthRefreshCoordinator: {
        type: "durable-object",
        storage: "sqlite",
      },
    });
  });
});
