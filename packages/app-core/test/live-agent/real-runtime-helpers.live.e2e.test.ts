import { appLifeOpsPlugin } from "@elizaos/app-lifeops";
import { ModelType, stringToUuid } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { itIf } from "../../../../test/helpers/conditional-tests.ts";
import { selectLiveProvider } from "../../../../test/helpers/live-provider";
import { ConversationHarness } from "../helpers/conversation-harness.js";
import { createRealTestRuntime } from "../helpers/real-runtime.ts";

const liveModelTestsEnabled = process.env.ELIZA_LIVE_TEST === "1";
const selectedLiveProvider = liveModelTestsEnabled
  ? selectLiveProvider()
  : null;
const canRunLiveTests = liveModelTestsEnabled && selectedLiveProvider !== null;

describe("Real Runtime Helper Regressions", () => {
  let runtimeResult: Awaited<ReturnType<typeof createRealTestRuntime>>;

  beforeAll(async () => {
    runtimeResult = await createRealTestRuntime({
      withLLM: canRunLiveTests,
      preferredProvider: selectedLiveProvider?.name,
      advancedCapabilities: true,
      plugins: [appLifeOpsPlugin],
      characterName: "HelperRegressionAgent",
    });
  }, 120_000);

  afterAll(async () => {
    await runtimeResult.cleanup();
  }, 120_000);

  it("preserves world ownership metadata during harness setup", async () => {
    const ownerId = stringToUuid("real-runtime-helper-owner");
    const harness = new ConversationHarness(runtimeResult.runtime, {
      userId: ownerId,
      userName: "Owner",
    });

    try {
      await harness.setup();

      const world = await runtimeResult.runtime.getWorld(harness.worldId);
      expect(world?.metadata?.ownership?.ownerId).toBe(ownerId);
      expect(world?.metadata?.roles?.[ownerId]).toBe("OWNER");
      expect(world?.messageServerId).toBe(ownerId);
    } finally {
      await harness.cleanup();
    }
  });

  itIf(canRunLiveTests)(
    "registers live provider text models when an LLM provider is configured",
    async () => {
      expect(runtimeResult.runtime.getModel(ModelType.TEXT_SMALL)).toBeTypeOf(
        "function",
      );
      expect(
        runtimeResult.runtime.getModel(ModelType.ACTION_PLANNER),
      ).toBeTypeOf("function");
    },
    120_000,
  );
});
