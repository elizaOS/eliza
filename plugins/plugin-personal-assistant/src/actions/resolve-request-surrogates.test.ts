import { describe, expect, it } from "vitest";
import { buildResolveRequestChoice } from "./resolve-request";

describe("buildResolveRequestChoice surrogate safety", () => {
  it("truncates long reasons without bisecting surrogate pairs", () => {
    const emojis = "🔥".repeat(100); // 200 code units > 48
    const choice = buildResolveRequestChoice("approve", [
      {
        id: "req-1",
        action: "send_email",
        channel: "email",
        reason: emojis,
        payload: {},
        createdAt: "2026-08-24T00:00:00Z",
      } as any,
    ]);

    expect(choice.options).toHaveLength(1);
    const label = choice.options[0].label;
    expect(label.endsWith("…")).toBe(true);
    for (const char of label) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });
});
