import { describe, expect, it } from "vitest";
import { ADAPTER_NAME_TO_TAB } from "./CodingAgentSettingsSection";

describe("ADAPTER_NAME_TO_TAB", () => {
  it("maps full adapter names from preflight API to tab keys", () => {
    expect(ADAPTER_NAME_TO_TAB["claude code"]).toBe("claude");
    expect(ADAPTER_NAME_TO_TAB["google gemini"]).toBe("gemini");
    expect(ADAPTER_NAME_TO_TAB["openai codex"]).toBe("codex");
    expect(ADAPTER_NAME_TO_TAB["aider"]).toBe("aider");
  });

  it("maps short adapter names for backwards compatibility", () => {
    expect(ADAPTER_NAME_TO_TAB["claude"]).toBe("claude");
    expect(ADAPTER_NAME_TO_TAB["gemini"]).toBe("gemini");
    expect(ADAPTER_NAME_TO_TAB["codex"]).toBe("codex");
  });

  it("returns undefined for unknown adapter names", () => {
    expect(ADAPTER_NAME_TO_TAB["unknown-agent"]).toBeUndefined();
    expect(ADAPTER_NAME_TO_TAB[""]).toBeUndefined();
  });

  it("handles the lowercase normalization used at the call site", () => {
    // The call site does `item.adapter?.toLowerCase()` before lookup,
    // so the map only needs lowercase keys
    const simulatePreflight = (adapterName: string) =>
      ADAPTER_NAME_TO_TAB[adapterName.toLowerCase()];

    expect(simulatePreflight("Claude Code")).toBe("claude");
    expect(simulatePreflight("Google Gemini")).toBe("gemini");
    expect(simulatePreflight("OpenAI Codex")).toBe("codex");
    expect(simulatePreflight("Aider")).toBe("aider");
  });
});
