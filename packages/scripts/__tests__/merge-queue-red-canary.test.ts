import { describe, expect, it } from "bun:test";

describe("merge queue red canary for #13386", () => {
  it("intentionally fails to prove required checks block merge", () => {
    expect("blocked-by-required-checks").toBe("mergeable");
  });
});
