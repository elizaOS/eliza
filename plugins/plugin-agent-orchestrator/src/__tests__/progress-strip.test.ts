import { describe, expect, it } from "vitest";
import { sanitizePlannerText, stripProgressLabelPrefix } from "../index.js";

describe("stripProgressLabelPrefix", () => {
  it("strips a 💬 label prefix on a narration line", () => {
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
    // Without alternation, `[…⚠️…]` would only match U+26A0, leaving U+FE0F
    // and the bracket behind. The regex MUST be alternation-based.
    expect(stripProgressLabelPrefix("⚠️ [foo] auth error")).toBe(
      "⚠️ auth error",
    );
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
});

describe("sanitizePlannerText", () => {
  it("returns input unchanged when no forbidden pattern matches", () => {
    expect(sanitizePlannerText("All clear, no cleanup needed.")).toBe(
      "All clear, no cleanup needed.",
    );
  });

  it("rewrites obsolete restart-acpx advice to the self-heal canonical line", () => {
    const out = sanitizePlannerText(
      "I will restart the acpx daemon to clear stale sessions.",
    );
    expect(out).toContain("self-heals");
    expect(out).not.toMatch(/restart/i);
    expect(out).not.toMatch(/stale sessions/i);
  });

  it("returns standalone self-heal line when ALL content was paraphrased away", () => {
    const out = sanitizePlannerText("restart acpx.");
    expect(out).toBe(
      "(Sub-agent state self-heals; respawning a fresh one automatically.)",
    );
  });

  it("treats empty input as a no-op", () => {
    expect(sanitizePlannerText("")).toBe("");
  });
});
