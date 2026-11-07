import { describe, expect, it } from "vitest";
import { countTwitterWeightedLength } from "./tweet-length";
import { splitTweetContent } from "./utils";

const LIMIT = 280;

function expectWithinLimit(parts: string[]) {
  for (const part of parts) {
    expect(part.length).toBeGreaterThan(0);
    expect(part.trim().length).toBeGreaterThan(0);
    expect(countTwitterWeightedLength(part)).toBeLessThanOrEqual(LIMIT);
  }
}

describe("splitTweetContent", () => {
  it("cuts long English text at a space instead of inside a word", () => {
    const text =
      "We just shipped the new deployment pipeline for the agent runtime. Builds now run in parallel across every package, " +
      "cache hits skip the typecheck step, and failed jobs report the exact package that broke instead of a wall of logs. " +
      "Next up is wiring the release notes generator into the same flow so every tag gets a summary automatically.";

    const parts = splitTweetContent(text, LIMIT);

    expect(parts.length).toBe(2);
    expect(parts.join("")).toBe(text);
    expectWithinLimit(parts);
    for (let i = 0; i + 1 < parts.length; i += 1) {
      expect(parts[i]).toMatch(/\s$/);
      expect(parts[i + 1]).toMatch(/^\S/);
    }
  });

  it("keeps a URL near the boundary whole", () => {
    const url =
      "https://example.com/releases/agent-runtime/deployment-pipeline";
    const text = `${"word ".repeat(52)}read more at ${url} and tell us what you think about it.`;

    const parts = splitTweetContent(text, LIMIT);

    expect(parts.length).toBe(2);
    expect(parts.join("")).toBe(text);
    expectWithinLimit(parts);
    expect(parts.filter((part) => part.includes(url))).toHaveLength(1);
  });

  it("splits long CJK text with no spaces losslessly within the limit", () => {
    const text = "分散型エージェントの新しい配備手順を公開しました".repeat(20);

    const parts = splitTweetContent(text, LIMIT);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(text);
    expectWithinLimit(parts);
  });

  it("returns text within the limit as a single part", () => {
    const text = "Short update: the deployment pipeline is live.";

    expect(splitTweetContent(text, LIMIT)).toEqual([text]);
  });
});
