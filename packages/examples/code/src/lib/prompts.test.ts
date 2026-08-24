/** Asserts the shared Code-example system-prompt contract against its real constant: deterministic, no device. */
import { describe, expect, it } from "vitest";
import { CODE_ASSISTANT_SYSTEM_PROMPT } from "./prompts.js";

describe("CODE_ASSISTANT_SYSTEM_PROMPT", () => {
  it("is a non-empty identity prompt for the Eliza Code agent", () => {
    expect(typeof CODE_ASSISTANT_SYSTEM_PROMPT).toBe("string");
    expect(CODE_ASSISTANT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(
      CODE_ASSISTANT_SYSTEM_PROMPT.trimStart().startsWith("You are Eliza Code"),
    ).toBe(true);
  });

  it("names every tool the workflow mandates: READ, EDIT, WRITE and SHELL", () => {
    // The prompt orders tool-first work; dropping any mandated tool name would
    // silently un-teach that step of the loop.
    expect(CODE_ASSISTANT_SYSTEM_PROMPT).toContain("READ");
    expect(CODE_ASSISTANT_SYSTEM_PROMPT).toContain("EDIT");
    expect(CODE_ASSISTANT_SYSTEM_PROMPT).toContain("WRITE");
    expect(CODE_ASSISTANT_SYSTEM_PROMPT).toContain("SHELL");
    expect(CODE_ASSISTANT_SYSTEM_PROMPT).toContain("READ/EDIT/WRITE and SHELL");
  });

  it("reserves REPLY for after the work is done", () => {
    expect(CODE_ASSISTANT_SYSTEM_PROMPT).toContain("(REPLY)");
  });

  it("mandates verification of real results before reporting done", () => {
    expect(CODE_ASSISTANT_SYSTEM_PROMPT).toContain("- Verify:");
  });

  it("carries no unresolved template placeholders", () => {
    // agent.ts interpolates this constant verbatim into the model's system
    // message, so an unrendered placeholder would leak straight to the model.
    expect(CODE_ASSISTANT_SYSTEM_PROMPT).not.toContain("{{");
    expect(CODE_ASSISTANT_SYSTEM_PROMPT).not.toContain("TODO");
  });
});
