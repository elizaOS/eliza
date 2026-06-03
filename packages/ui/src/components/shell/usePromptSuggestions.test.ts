import { describe, expect, it } from "vitest";

import type { ShellMessage } from "./shell-state";
import { computePromptSuggestions } from "./usePromptSuggestions";

const msg = (id: string, role: ShellMessage["role"], content: string) =>
  ({ id, role, content, createdAt: 0 }) as ShellMessage;

describe("computePromptSuggestions", () => {
  it("returns exactly 5 suggestions for an empty thread", () => {
    const out = computePromptSuggestions([]);
    expect(out).toHaveLength(5);
  });

  it("returns unique (deduped) suggestions", () => {
    const out = computePromptSuggestions([]);
    expect(new Set(out).size).toBe(out.length);
  });

  it("leads with the cold-start starter when there is no thread", () => {
    const out = computePromptSuggestions([
      msg("a", "user", "   "), // whitespace-only does not count as a thread
    ]);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe("What can you do?");
  });

  it("swaps slot 0 for the continue-thread follow-up once a thread exists", () => {
    const out = computePromptSuggestions([
      msg("a", "user", "hi"),
      msg("b", "assistant", "hey there"),
    ]);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe("Continue where we left off");
    expect(new Set(out).size).toBe(5);
  });
});
