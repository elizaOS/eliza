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

  it("leads with the neutral starter when there is no thread and no clock", () => {
    const out = computePromptSuggestions([
      msg("a", "user", "   "), // whitespace-only does not count as a thread
    ]);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe("What can you do?");
  });

  it("tailors the cold-start lead to the time of day", () => {
    expect(computePromptSuggestions([], 8)[0]).toBe("Plan my day"); // morning
    expect(computePromptSuggestions([], 14)[0]).toBe("What's left today?"); // afternoon
    expect(computePromptSuggestions([], 21)[0]).toBe("Recap my day"); // evening
    expect(computePromptSuggestions([], 3)[0]).toBe("Recap my day"); // late night
    // still exactly 5 unique regardless of the hour
    for (const h of [8, 14, 21, 3]) {
      const out = computePromptSuggestions([], h);
      expect(out).toHaveLength(5);
      expect(new Set(out).size).toBe(5);
    }
  });

  it("history beats time of day: an active thread always leads with the follow-up", () => {
    const thread = [msg("a", "user", "hi"), msg("b", "assistant", "hey there")];
    for (const h of [8, 14, 21, undefined]) {
      const out = computePromptSuggestions(thread, h);
      expect(out).toHaveLength(5);
      expect(out[0]).toBe("Continue where we left off");
      expect(new Set(out).size).toBe(5);
    }
  });
});
