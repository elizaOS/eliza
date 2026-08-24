/**
 * Unit tests for task-agent-routing: validates adapter name normalization and known types.
 */
import { describe, expect, it } from "vitest";
import {
  KNOWN_ADAPTER_TYPES,
  normalizeTaskAgentAdapter,
} from "./task-agent-routing.ts";

describe("task-agent-routing", () => {
  it("includes standard coding backends in KNOWN_ADAPTER_TYPES", () => {
    expect(KNOWN_ADAPTER_TYPES.size).toBeGreaterThan(0);
    expect(KNOWN_ADAPTER_TYPES.has("claude")).toBe(true);
    expect(KNOWN_ADAPTER_TYPES.has("codex")).toBe(true);
  });

  it("normalizes alias strings to canonical adapter names", () => {
    expect(normalizeTaskAgentAdapter("claude-code")).toBe("claude");
    expect(normalizeTaskAgentAdapter("openai-codex")).toBe("codex");
    expect(normalizeTaskAgentAdapter("kimi-code")).toBe("kimi");
    expect(normalizeTaskAgentAdapter("grok-build")).toBe("grok");
    expect(normalizeTaskAgentAdapter("pi-agent")).toBe("pi-agent");
    expect(normalizeTaskAgentAdapter("eliza-os")).toBe("elizaos");
    expect(normalizeTaskAgentAdapter("")).toBeUndefined();
    expect(normalizeTaskAgentAdapter(undefined)).toBeUndefined();
  });
});
