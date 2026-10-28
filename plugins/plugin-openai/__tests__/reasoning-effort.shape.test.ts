/** Pure provider configuration regressions; no model handler or transport is invoked. */
import type { GenerateTextParams, IAgentRuntime } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { __INTERNAL_resolveProviderOptions as resolve } from "../models/text";

afterEach(() => vi.unstubAllEnvs());
const runtime = (effort?: string) =>
  ({
    getSetting: (key: string) =>
      key === "ELIZA_PROVIDER"
        ? "cerebras"
        : key === "OPENAI_REASONING_EFFORT"
          ? (effort ?? null)
          : null,
  }) as unknown as IAgentRuntime;
const effort = (params: GenerateTextParams = {}, configured?: string, model = "qwen-3.8-27b") =>
  (resolve(params, runtime(configured), model)?.openai as { reasoningEffort?: string } | undefined)
    ?.reasoningEffort;

it("honors an environment-only effort for background extraction without adding call options", () => {
  vi.stubEnv("OPENAI_REASONING_EFFORT", "none");
  expect(
    effort({
      temperature: 0,
      providerOptions: { eliza: { conversationId: "synthetic-background" } },
    })
  ).toBe("none");
});
it("preserves explicit runtime preference before the environment default", () => {
  vi.stubEnv("OPENAI_REASONING_EFFORT", "none");
  expect(effort({}, "medium")).toBe("medium");
});
it("preserves an explicit caller or role effort before the environment default", () => {
  vi.stubEnv("OPENAI_REASONING_EFFORT", "none");
  expect(effort({ providerOptions: { openai: { reasoningEffort: "high" } } })).toBe("high");
});
it("does not promote tool reasoning when the operator environment disables it", () => {
  vi.stubEnv("OPENAI_REASONING_EFFORT", "none");
  expect(
    effort({ providerOptions: { eliza: { thinking: "off", preferToolReasoning: true } } })
  ).toBe("none");
});
it("keeps explicit thinking-on behavior and foreground thinking-off behavior", () => {
  vi.stubEnv("OPENAI_REASONING_EFFORT", "none");
  expect(effort({ providerOptions: { eliza: { thinking: "on" } } })).toBe("low");
  expect(effort({ providerOptions: { eliza: { thinking: "off" } } })).toBe("none");
});
it("keeps the documented default when no operator or caller effort is supplied", () => {
  vi.stubEnv("OPENAI_REASONING_EFFORT", undefined);
  expect(effort()).toBe("high");
});
it("does not send an unsupported none effort to an unknown model", () => {
  vi.stubEnv("OPENAI_REASONING_EFFORT", "none");
  expect(effort({}, undefined, "unlisted-model")).toBeUndefined();
});
it("preserves the cache metadata and input object when resolving the environment", () => {
  vi.stubEnv("OPENAI_REASONING_EFFORT", "none");
  const params = {
    providerOptions: {
      eliza: { prefixHash: "synthetic-prefix" },
      openai: { promptCacheKey: "synthetic-cache" },
    },
  };
  const before = structuredClone(params);
  expect(resolve(params, runtime(), "qwen-3.8-27b")?.eliza).toEqual(params.providerOptions.eliza);
  expect(params).toEqual(before);
});
