/**
 * Unit tests for surrogate-safe truncation in Docker node manager probe logs.
 *
 * Tests that sidecar probe output truncated across UTF-16 surrogate boundaries
 * remains well-formed without lone surrogates.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

describe("docker-node-manager surrogate-safe output truncation", () => {
  it("preserves well-formed strings when probe output splits across surrogate pair", () => {
    const base = "x".repeat(199);
    const surrogateEmoji = "🐳"; // \uD83D\uDC33
    const output = `${base}${surrogateEmoji} extra probe output`;

    const truncated = truncateWellFormed(toWellFormedUnicode(output), 200);
    expect(truncated.length).toBeLessThanOrEqual(200);
    expect(truncated.endsWith("\uD83D")).toBe(false);
    expect(truncated.isWellFormed?.() ?? true).toBe(true);
  });
});
