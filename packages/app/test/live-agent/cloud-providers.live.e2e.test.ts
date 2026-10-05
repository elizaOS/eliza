import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../helpers/conditional-tests.ts";
import {
  type LiveProviderConfig,
  selectLiveProvider,
} from "../helpers/live-provider.ts";
import { createRealTestRuntime } from "../helpers/real-runtime.ts";

const LIVE_TESTS_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const liveProvider = LIVE_TESTS_ENABLED ? selectLiveProvider() : null;
const CAN_RUN = LIVE_TESTS_ENABLED && liveProvider !== null;

async function getGeneratedText(result: unknown): Promise<string> {
  if (typeof result === "string") {
    return result.trim();
  }
  if (!result || typeof result !== "object") {
    return String(result ?? "").trim();
  }
  const textValue = (result as { text?: unknown }).text;
  if (
    textValue &&
    typeof textValue === "object" &&
    typeof (textValue as PromiseLike<unknown>).then === "function"
  ) {
    return String(await (textValue as PromiseLike<unknown>)).trim();
  }
  return String(textValue ?? "").trim();
}

describeIf(CAN_RUN)("Live model provider roundtrip", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let providerConfig: LiveProviderConfig;
  let runtimeResult: Awaited<ReturnType<typeof createRealTestRuntime>>;

  beforeAll(async () => {
    providerConfig = liveProvider as LiveProviderConfig;
    runtimeResult = await createRealTestRuntime({
      characterName: "CloudProvidersLive",
      preferredProvider: providerConfig.name,
      withLLM: true,
    });
    cleanup = runtimeResult.cleanup;
  }, 180_000);

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it("generates text through the configured live provider", async () => {
    expect(runtimeResult.providerName).toBe(providerConfig.name);

    const response = await runtimeResult.runtime.generateText(
      "Reply with exactly: HELLO_TEST",
      { maxTokens: 32 },
    );
    const text = await getGeneratedText(response);

    expect(text).toContain("HELLO_TEST");
  }, 60_000);
});
