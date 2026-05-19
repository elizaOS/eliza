import { describe, expect, it } from "vitest";
import { stripProgressLabelPrefix } from "../../src/index.js";

describe("stripProgressLabelPrefix", () => {
  it("strips a 💬 narration label prefix", () => {
    expect(stripProgressLabelPrefix("💬 [foo] Reading file...")).toBe(
      "💬 Reading file...",
    );
  });

  it("strips ⏳ heartbeat prefix", () => {
    expect(
      stripProgressLabelPrefix("⏳ [my-label] still iterating on styles.css"),
    ).toBe("⏳ still iterating on styles.css");
  });

  it("strips ⚠️ (variation-selector composite) — regression for character-class bug", () => {
    // Earlier revisions used `[💬⏳⚠️⏸️…]` which only matches the first
    // codepoint (U+26A0), leaving U+FE0F + the bracket behind. The regex
    // MUST use alternation so the full grapheme is consumed.
    expect(stripProgressLabelPrefix("⚠️ [foo] auth error")).toBe("⚠️ auth error");
  });

  it("strips ⏸️ (variation-selector composite)", () => {
    expect(stripProgressLabelPrefix("⏸️ [bar] blocked")).toBe("⏸️ blocked");
  });

  it("strips ✅ / ❌ / 🚀 prefixes", () => {
    expect(stripProgressLabelPrefix("✅ [a] done")).toBe("✅ done");
    expect(stripProgressLabelPrefix("❌ [b] failed")).toBe("❌ failed");
    expect(stripProgressLabelPrefix("🚀 [c] running")).toBe("🚀 running");
  });

  it("leaves text without a known prefix untouched", () => {
    expect(stripProgressLabelPrefix("plain message")).toBe("plain message");
    expect(stripProgressLabelPrefix("📦 [foo] not a progress emoji")).toBe(
      "📦 [foo] not a progress emoji",
    );
  });

  it("only strips ONE leading prefix even if the body contains another", () => {
    expect(stripProgressLabelPrefix("💬 [a] saw ⏳ [b] inside")).toBe(
      "💬 saw ⏳ [b] inside",
    );
  });

  it("does not strip when the bracket label is missing", () => {
    expect(stripProgressLabelPrefix("💬 no bracket here")).toBe(
      "💬 no bracket here",
    );
  });
});
