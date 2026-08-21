/** Exercises linear-time public sanitizers with adversarial 100k-character runs. */
import { describe, expect, it } from "vitest";
import { extractBulkItems } from "../../src/actions/tasks.ts";
import { sanitizePlannerText } from "../../src/index.ts";
import { normalizeClaudeAcpModelId } from "../../src/services/acp-service.ts";
import { redactCodingMemoryText } from "../../src/services/curated-coding-memory.ts";
import { normalizeRepositoryInput } from "../../src/services/repo-input.ts";
import { stripToolTranscript } from "../../src/services/transcript-sanitizer.ts";
import { parseOwnerRepo } from "../../src/services/workspace-github.ts";

describe("polynomial edge-run regressions", () => {
  it("handles 100k trailing delimiters and unterminated envelopes", () => {
    expect(
      normalizeRepositoryInput(
        `https://github.com/elizaOS/eliza${"/".repeat(100_000)}`,
      ),
    ).toBe("https://github.com/elizaOS/eliza.git");
    expect(
      stripToolTranscript(`[tool output:${"[tool output:".repeat(10_000)}`),
    ).toBe("");
    expect(() => parseOwnerRepo(`#${"#".repeat(100_000)}`)).toThrow();
  });

  it("redacts large key blocks and strips repeated model suffixes", () => {
    const key = `-----BEGIN PRIVATE KEY-----${"A".repeat(100_000)}-----END PRIVATE KEY-----`;
    expect(redactCodingMemoryText(key)).toBe("[REDACTED]");
    expect(
      normalizeClaudeAcpModelId(`claude${" [123ms]".repeat(10_000)}`),
    ).toBe("claude");
  });

  it("filters forbidden recovery prose with a 100k whitespace run", () => {
    const result = sanitizePlannerText(`restart${" ".repeat(100_000)}acpx.`);
    expect(result).toContain("self-heals");
    expect(result).not.toContain("acpx");
  });

  it("does not treat decimal versions as numbered issue markers", () => {
    expect(extractBulkItems("release 1.2 works with runtime 3.4")).toEqual([]);
    expect(extractBulkItems("1. first issue 2. second issue")).toEqual([
      { title: "first issue" },
      { title: "second issue" },
    ]);
  });
});
