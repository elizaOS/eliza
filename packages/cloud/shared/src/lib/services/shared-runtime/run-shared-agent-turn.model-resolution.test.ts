/**
 * Verifies that Shared turns honor the Cloud small-model configuration while
 * retaining the canonical Cerebras default when no override is present.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { CEREBRAS_DEFAULT_TEXT_SMALL_MODEL } from "../../models/catalog";
import { resolveSharedAgentTurnModel } from "./run-shared-agent-turn";

const originalSmallModel = process.env.ELIZAOS_CLOUD_SMALL_MODEL;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalCerebrasKey = process.env.CEREBRAS_API_KEY;

afterEach(() => {
  if (originalSmallModel === undefined) delete process.env.ELIZAOS_CLOUD_SMALL_MODEL;
  else process.env.ELIZAOS_CLOUD_SMALL_MODEL = originalSmallModel;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
  if (originalCerebrasKey === undefined) delete process.env.CEREBRAS_API_KEY;
  else process.env.CEREBRAS_API_KEY = originalCerebrasKey;
});

describe("resolveSharedAgentTurnModel", () => {
  test("uses the configured Cloud small model when its provider is available", () => {
    process.env.ELIZAOS_CLOUD_SMALL_MODEL = "openai/gpt-4o-mini";
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.CEREBRAS_API_KEY;

    expect(resolveSharedAgentTurnModel()).toBe("openai/gpt-4o-mini");
  });

  test("retains the canonical Cerebras default without an override", () => {
    delete process.env.ELIZAOS_CLOUD_SMALL_MODEL;
    delete process.env.OPENAI_API_KEY;
    process.env.CEREBRAS_API_KEY = "test-cerebras-key";

    expect(resolveSharedAgentTurnModel()).toBe(CEREBRAS_DEFAULT_TEXT_SMALL_MODEL);
  });
});
