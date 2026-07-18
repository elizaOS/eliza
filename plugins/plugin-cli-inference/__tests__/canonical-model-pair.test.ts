/**
 * Covers canonical two-knob derivation (ELIZA_MODEL_SMALL/LARGE) through the
 * claude-sdk / codex-sdk tier resolvers: the pair feeds large + planner +
 * triage tiers when the ELIZA_CLI_* escape hatches are unset, loses to them
 * when set, and never crosses families. Deterministic — stub runtime settings.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveCodexModel, resolveSdkModel } from "../index";

const runtimeWith = (map: Record<string, string>) =>
  ({
    getSetting: (key: string) => map[key] ?? null,
  }) as unknown as IAgentRuntime;

describe("claude-sdk canonical pair", () => {
  it("derives large replies + small planner/triage from the pair alone", () => {
    const runtime = runtimeWith({
      ELIZA_MODEL_SMALL: "claude-sonnet-5",
      ELIZA_MODEL_LARGE: "claude-opus-4-8",
    });
    expect(resolveSdkModel(runtime, ModelType.TEXT_LARGE)).toBe("claude-opus-4-8");
    expect(resolveSdkModel(runtime, ModelType.ACTION_PLANNER)).toBe("claude-sonnet-5");
    expect(resolveSdkModel(runtime, ModelType.TEXT_SMALL)).toBe("claude-sonnet-5");
  });

  it("keeps ELIZA_CLI_CLAUDE_* as winning escape hatches", () => {
    const runtime = runtimeWith({
      ELIZA_CLI_CLAUDE_MODEL: "explicit-large",
      ELIZA_CLI_CLAUDE_PLANNER_MODEL: "explicit-planner",
      ELIZA_MODEL_SMALL: "claude-sonnet-5",
      ELIZA_MODEL_LARGE: "claude-opus-4-8",
    });
    expect(resolveSdkModel(runtime, ModelType.TEXT_LARGE)).toBe("explicit-large");
    expect(resolveSdkModel(runtime, ModelType.ACTION_PLANNER)).toBe("explicit-planner");
  });

  it("accepts anthropic-qualified values and rejects other families", () => {
    const anthro = runtimeWith({ ELIZA_MODEL_LARGE: "anthropic/claude-opus-4-8" });
    expect(resolveSdkModel(anthro, ModelType.TEXT_LARGE)).toBe("claude-opus-4-8");
    const foreign = runtimeWith({ ELIZA_MODEL_LARGE: "ollama/eliza-1-4b" });
    expect(resolveSdkModel(foreign, ModelType.TEXT_LARGE)).toBe("claude-opus-4-8");
  });

  it("changes nothing when the pair is unset", () => {
    expect(resolveSdkModel(runtimeWith({}), ModelType.TEXT_LARGE)).toBe("claude-opus-4-8");
    expect(resolveSdkModel(runtimeWith({}), ModelType.ACTION_PLANNER)).toBe("claude-opus-4-8");
  });
});

describe("codex-sdk canonical pair", () => {
  it("derives tiers from the pair with openai/codex family gating", () => {
    const runtime = runtimeWith({
      ELIZA_MODEL_SMALL: "openai/gpt-5.5",
      ELIZA_MODEL_LARGE: "gpt-5.6-sol",
    });
    expect(resolveCodexModel(runtime, ModelType.TEXT_LARGE)).toBe("gpt-5.6-sol");
    expect(resolveCodexModel(runtime, ModelType.ACTION_PLANNER)).toBe("gpt-5.5");
  });

  it("keeps explicit codex vars winning and default when pair is foreign", () => {
    const explicit = runtimeWith({
      ELIZA_CLI_CODEX_MODEL: "explicit-codex",
      ELIZA_MODEL_LARGE: "gpt-5.6-sol",
    });
    expect(resolveCodexModel(explicit, ModelType.TEXT_LARGE)).toBe("explicit-codex");
    const foreign = runtimeWith({ ELIZA_MODEL_LARGE: "anthropic/claude-opus-4-8" });
    expect(resolveCodexModel(foreign, ModelType.TEXT_LARGE)).toBe("gpt-5.5");
  });
});
