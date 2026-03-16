import { afterEach, describe, expect, test } from "vitest";
import { ClaudeAgentSdkSubAgent } from "../lib/sub-agents/claude-agent-sdk-sub-agent.js";
import { CodexSdkSubAgent } from "../lib/sub-agents/codex-sdk-sub-agent.js";
import { ElizaSubAgent } from "../lib/sub-agents/eliza-sub-agent.js";
import { createSubAgent } from "../lib/sub-agents/registry.js";

describe("sub-agent registry", () => {
  afterEach(() => {
    delete process.env.ELIZA_CODE_USE_SDK_WORKERS;
  });

  test("returns SDK workers when enabled", () => {
    process.env.ELIZA_CODE_USE_SDK_WORKERS = "1";
    expect(createSubAgent("claude-code")).toBeInstanceOf(
      ClaudeAgentSdkSubAgent,
    );
    expect(createSubAgent("codex")).toBeInstanceOf(CodexSdkSubAgent);
  });

  test("returns prompt-based workers when disabled", () => {
    process.env.ELIZA_CODE_USE_SDK_WORKERS = "0";
    const claude = createSubAgent("claude-code");
    const codex = createSubAgent("codex");
    expect(claude).toBeInstanceOf(ElizaSubAgent);
    expect(codex).toBeInstanceOf(ElizaSubAgent);
  });
});
