/** Verifies parent-agent prompt text remains complete and Unicode-safe. */

import { describe, expect, it } from "vitest";
import { normalizePromptText } from "../../src/services/parent-agent-broker.ts";

describe("parent-agent broker prompt normalization", () => {
  it("preserves a long prompt beyond the former preview limit", () => {
    const input = `${"a".repeat(10_000)}🦊tail`;
    expect(normalizePromptText(input)).toBe(input);
  });

  it("repairs lone surrogates without shortening text", () => {
    const input = `${"a".repeat(10_000)}\uD800tail`;
    expect(normalizePromptText(input)).toBe(`${"a".repeat(10_000)}�tail`);
  });
});
