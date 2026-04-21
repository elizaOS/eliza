/**
 * LifeOps parameter extraction tests with real LLM.
 *
 * Verifies that the extraction prompts produce correctly structured JSON
 * using a real LLM provider. No mock models, no hardcoded responses.
 *
 * Validates schema shape and reasonable values rather than exact strings,
 * making the tests robust to LLM variation across providers.
 *
 * Requires at least one LLM provider API key. Skips when unavailable.
 */

import {
  buildExtractionPrompt,
  extractTaskCreatePlanWithLlm,
  extractTaskParamsWithLlm,
} from "@elizaos/app-lifeops/actions/life-param-extractor.js";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectLiveProvider } from "../../../../../test/helpers/live-provider";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../../../test/helpers/real-runtime";

const provider = selectLiveProvider();
const describeWithLLM = provider ? describe : describe.skip;

describeWithLLM("extractTaskParamsWithLlm (real LLM)", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({ withLLM: true });
    runtime = testResult.runtime;
  }, 180_000);

  afterAll(async () => {
    await testResult.cleanup();
  });

  it("extracts structured params for a weekly phone call", async () => {
    const result = await extractTaskParamsWithLlm({
      runtime,
      intent: "call mom every Sunday at 3pm",
      state: undefined,
    });

    // Verify schema — the LLM should produce a valid structured output
    expect(result).toBeTruthy();
    expect(typeof result.title).toBe("string");
    expect(result.title).toBeTruthy();

    // The cadence should reflect weekly scheduling
    expect(result.cadenceKind).toBe("weekly");

    // Time should be extracted (exact format may vary by LLM)
    expect(result.timeOfDay).toBeTruthy();
  }, 60_000);

  it("extracts structured params for a daily morning routine", async () => {
    const result = await extractTaskParamsWithLlm({
      runtime,
      intent: "remind me to take vitamins every morning at 8am",
      state: undefined,
    });

    expect(result).toBeTruthy();
    expect(typeof result.title).toBe("string");
    expect(result.title).toBeTruthy();
    expect(result.cadenceKind).toBe("daily");
    expect(result.timeOfDay).toBeTruthy();
  }, 60_000);

  it("returns null fields for empty intent", async () => {
    const result = await extractTaskParamsWithLlm({
      runtime,
      intent: "",
      state: undefined,
    });

    // Empty intent should produce an empty structured result
    expect(result).toBeTruthy();
    expect(result.title).toBeNull();
    expect(result.cadenceKind).toBeNull();
  }, 60_000);
});

describeWithLLM("extractTaskCreatePlanWithLlm (real LLM)", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({ withLLM: true });
    runtime = testResult.runtime;
  }, 180_000);

  afterAll(async () => {
    await testResult.cleanup();
  });

  it("produces a create plan for a brushing reminder", async () => {
    const result = await extractTaskCreatePlanWithLlm({
      runtime,
      intent: "remind me to brush teeth morning and night",
      state: undefined,
    });

    expect(result).toBeTruthy();
    expect(result.mode).toBe("create");
    expect(typeof result.title).toBe("string");
    expect(result.title).toBeTruthy();

    // Should identify as daily cadence with morning/night windows
    expect(result.cadenceKind).toBeTruthy();
    if (result.windows) {
      expect(Array.isArray(result.windows)).toBe(true);
    }
  }, 60_000);

  it("produces a create plan for a one-off timed reminder", async () => {
    const result = await extractTaskCreatePlanWithLlm({
      runtime,
      intent: "set a reminder for april 17 at 8pm mountain time to hug my wife",
      state: undefined,
    });

    expect(result).toBeTruthy();
    expect(result.mode).toBe("create");
    expect(typeof result.title).toBe("string");
    expect(result.title).toBeTruthy();

    // Should extract time and timezone
    expect(result.timeOfDay).toBeTruthy();
    if (result.timeZone) {
      expect(typeof result.timeZone).toBe("string");
    }
  }, 60_000);

  it("returns a structured respond plan when runtime has no model", async () => {
    // When useModel is not available, should gracefully return a respond plan
    const result = await extractTaskCreatePlanWithLlm({
      runtime: {} as AgentRuntime,
      intent: "brush teeth daily",
      state: undefined,
    });

    expect(result).toBeTruthy();
    expect(result.mode).toBe("respond");
    expect(result.title).toBeNull();
  }, 30_000);
});

describe("buildExtractionPrompt", () => {
  it("includes the intent in the prompt", () => {
    const prompt = buildExtractionPrompt(
      "call mom every Sunday at 3pm",
      "user: call mom every Sunday at 3pm",
    );
    expect(prompt).toContain("call mom every Sunday at 3pm");
    expect(prompt).toContain(
      "Plan the next step for a LifeOps create_definition request.",
    );
    expect(prompt).toContain("Return ONLY valid JSON");
  });
});
