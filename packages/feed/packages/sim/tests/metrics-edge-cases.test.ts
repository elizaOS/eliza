import { describe, expect, it } from "bun:test";
import { DefaultTickMetrics } from "../core/metrics";

describe("DefaultTickMetrics edge cases", () => {
  it("warns when incrementing a string value", () => {
    const m = new DefaultTickMetrics();
    m.set("label", "hello");
    m.increment("label", 5);

    // Value should not change
    expect(m.get("label")).toBe("hello");
    // Should have generated a warning
    const warnings = m.warnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("Cannot increment non-numeric");
    expect(warnings[0]).toContain("label");
  });

  it("warns when incrementing a boolean value", () => {
    const m = new DefaultTickMetrics();
    m.set("flag", true);
    m.increment("flag");

    expect(m.get("flag")).toBe(true);
    expect(m.warnings().length).toBe(1);
  });

  it("increment with amount=0 sets to 0 for new keys", () => {
    const m = new DefaultTickMetrics();
    m.increment("zero", 0);
    expect(m.get("zero")).toBe(0);
  });

  it("increment with negative amount decrements", () => {
    const m = new DefaultTickMetrics();
    m.set("count", 10);
    m.increment("count", -3);
    expect(m.get("count")).toBe(7);
  });

  it("snapshot returns a copy, not a reference", () => {
    const m = new DefaultTickMetrics();
    m.set("a", 1);
    const snap1 = m.snapshot();
    m.set("b", 2);
    const snap2 = m.snapshot();

    expect(snap1).toEqual({ a: 1 });
    expect(snap2).toEqual({ a: 1, b: 2 });
  });

  it("warnings returns a copy", () => {
    const m = new DefaultTickMetrics();
    m.addWarning("w1");
    const w = m.warnings();
    w.push("tampered");
    expect(m.warnings()).toEqual(["w1"]);
  });
});
