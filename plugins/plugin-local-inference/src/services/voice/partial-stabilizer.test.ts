import { describe, expect, it } from "vitest";
import { PartialStabilizer } from "./partial-stabilizer";

describe("PartialStabilizer (LocalAgreement-n)", () => {
  it("never commits anything from a single partial (n=2)", () => {
    const s = new PartialStabilizer();
    const out = s.feed("the cat");
    expect(out.stable).toBe("");
    expect(out.pending).toBe("the cat");
  });

  it("commits the common prefix once a second partial agrees", () => {
    const s = new PartialStabilizer();
    s.feed("the cat sa");
    const out = s.feed("the cat sat");
    // The two partials share the prefix "the cat sa".
    expect(out.stable).toBe("the cat sa");
    expect(out.pending).toBe("t");
  });

  it("extends the stable prefix as more partials agree", () => {
    const s = new PartialStabilizer();
    s.feed("the cat sa");
    s.feed("the cat sat");
    // Third partial agrees on "the cat sat" with the second.
    const out = s.feed("the cat sat on");
    expect(out.stable).toBe("the cat sat");
    expect(out.pending).toBe(" on");
  });

  it("does not roll back a committed prefix when a later partial briefly disagrees", () => {
    const s = new PartialStabilizer();
    s.feed("the cat sa");
    s.feed("the cat sat"); // stable becomes "the cat sa"
    const out = s.feed("the dog");
    expect(out.stable).toBe("the cat sa");
    // The new partial does not start with the committed prefix — the
    // whole new partial surfaces as pending so UI shows the fresh text.
    expect(out.pending).toBe("the dog");
  });

  it("respects a custom agreementCount", () => {
    const s = new PartialStabilizer({ agreementCount: 3 });
    expect(s.feed("hello").stable).toBe("");
    expect(s.feed("hello world").stable).toBe("");
    // Three identical partials needed before any prefix commits.
    const out = s.feed("hello world!");
    expect(out.stable).toBe("hello");
  });

  it("reset clears all state", () => {
    const s = new PartialStabilizer();
    s.feed("abc");
    s.feed("abcd"); // stable = "abc"
    expect(s.stable()).toBe("abc");
    s.reset();
    expect(s.stable()).toBe("");
    expect(s.feed("xyz").stable).toBe("");
  });

  it("rejects an invalid agreementCount", () => {
    expect(() => new PartialStabilizer({ agreementCount: 0 })).toThrow();
    expect(() => new PartialStabilizer({ agreementCount: -1 })).toThrow();
    expect(
      () => new PartialStabilizer({ agreementCount: Number.NaN }),
    ).toThrow();
  });
});
