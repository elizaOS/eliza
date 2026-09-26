/**
 * Deterministic AOSP final-wire tests prove native-token admission happens
 * before stream dispatch and that a retry cannot alter the admitted request.
 */

import { describe, expect, it, mock } from "bun:test";
import type { AospLlmStreamConfig } from "../src/aosp-llama-streaming";
import { createAospPreparedTextRequestGuard } from "../src/aosp-local-inference-bootstrap";

function makeConfig(): AospLlmStreamConfig {
  return {
    maxTokens: 64,
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    repeatPenalty: 1.1,
    slotId: -1,
    promptCacheKey: null,
    draftMin: 0,
    draftMax: 0,
    mtpDrafterPath: null,
    disableThinking: false,
    contextSize: 4096,
  };
}

describe("AOSP prepared model request", () => {
  it("uses the exact native prompt-token count", () => {
    const guard = createAospPreparedTextRequestGuard({
      modelPath: "/models/eliza-1.gguf",
      contextWindowTokens: 4096,
      prompt: "complete prompt",
      promptTokenCount: 137,
      config: makeConfig(),
    });
    expect(guard.budget.inputTokens).toBe(137);
    expect(guard.budget.countSource).toBe("provider-tokenizer");
  });

  it("rejects over-budget input before native stream dispatch", () => {
    const dispatch = mock(() => undefined);
    let rejection: unknown;
    expect(() => {
      try {
        const guard = createAospPreparedTextRequestGuard({
          modelPath: "/models/eliza-1.gguf",
          contextWindowTokens: 100,
          prompt: "complete prompt",
          promptTokenCount: 36,
          config: { ...makeConfig(), maxTokens: 64, contextSize: 100 },
        });
        guard.assertBeforeAttempt();
        dispatch();
      } catch (error) {
        rejection = error;
        throw error;
      }
    }).toThrow();
    expect((rejection as { code?: string }).code).toBe(
      "MODEL_INPUT_OVER_BUDGET",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects changed sampler input before the retry dispatch", () => {
    const config = makeConfig();
    const dispatch = mock(() => undefined);
    const guard = createAospPreparedTextRequestGuard({
      modelPath: "/models/eliza-1.gguf",
      contextWindowTokens: 4096,
      prompt: "complete prompt",
      promptTokenCount: 20,
      config,
    });
    guard.assertBeforeAttempt();
    dispatch();
    config.temperature = 0.2;
    let rejection: unknown;
    expect(() => {
      try {
        guard.assertBeforeAttempt();
        dispatch();
      } catch (error) {
        rejection = error;
        throw error;
      }
    }).toThrow();
    expect((rejection as { code?: string }).code).toBe(
      "MODEL_PREPARED_REQUEST_MUTATED",
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
