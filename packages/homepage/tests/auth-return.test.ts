import { describe, expect, test } from "bun:test";
import { safeReturnTo } from "../src/lib/auth-return";

describe("safe auth return paths", () => {
  test("accepts internal paths with query strings and hashes", () => {
    expect(safeReturnTo("/profile/edit?source=login#wallet")).toBe(
      "/profile/edit?source=login#wallet",
    );
  });

  test("rejects external, scheme-relative, and malformed destinations", () => {
    expect(safeReturnTo("https://example.com")).toBeNull();
    expect(safeReturnTo("//example.com/profile/edit")).toBeNull();
    expect(safeReturnTo("profile/edit")).toBeNull();
    expect(safeReturnTo(null)).toBeNull();
  });
});
