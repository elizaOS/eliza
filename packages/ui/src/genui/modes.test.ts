/**
 * Unit coverage for GenUI mode prompt assembly (standalone vs inline rules and
 * system prompt). Pure functions, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  buildCatalogPromptWithMode,
  getModePromptRules,
  getModeSystemPrompt,
  INLINE_MODE_PROMPT_RULES,
  STANDALONE_MODE_PROMPT_RULES,
} from "./modes";

/**
 * GenUI generation-mode prompt assembly. `modes.ts` builds the numbered rule
 * block and system-prompt header that tells the model whether to emit UI-only
 * JSONL (standalone) or converse-then-UI (inline). It isn't re-exported from
 * the genui barrel and had no test, so a regression in the rule selection or
 * numbering would silently change every GenUI generation. Pure string assembly.
 */
describe("getModePromptRules", () => {
  it("numbers the standalone rule set from 1", () => {
    const out = getModePromptRules("standalone");
    expect(out.startsWith(`1. ${STANDALONE_MODE_PROMPT_RULES[0]}`)).toBe(true);
    expect(out.split("\n")).toHaveLength(STANDALONE_MODE_PROMPT_RULES.length);
  });

  it("uses the inline rule set for inline mode", () => {
    const out = getModePromptRules("inline");
    expect(out.startsWith(`1. ${INLINE_MODE_PROMPT_RULES[0]}`)).toBe(true);
  });

  it("appends custom rules with continued numbering", () => {
    const out = getModePromptRules("standalone", ["Extra rule"]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(STANDALONE_MODE_PROMPT_RULES.length + 1);
    expect(lines[lines.length - 1]).toBe(
      `${STANDALONE_MODE_PROMPT_RULES.length + 1}. Extra rule`,
    );
  });
});

describe("getModeSystemPrompt", () => {
  it("defaults an empty config to standalone", () => {
    expect(getModeSystemPrompt({})).toContain("Standalone (UI-only)");
  });

  it("labels inline mode", () => {
    expect(getModeSystemPrompt({ mode: "inline" })).toContain(
      "Inline (conversation + UI)",
    );
  });
});

describe("buildCatalogPromptWithMode", () => {
  it("returns the catalog unchanged when no mode config is given", () => {
    expect(buildCatalogPromptWithMode("CATALOG")).toBe("CATALOG");
  });

  it("appends the mode system prompt when a config is given", () => {
    const out = buildCatalogPromptWithMode("CATALOG", { mode: "inline" });
    expect(out).toContain("CATALOG");
    expect(out).toContain("## Generation Mode:");
    expect(out).toContain("Inline (conversation + UI)");
  });
});
