import { describe, expect, it } from "vitest";
import {
  cleanHandle,
  cleanName,
  normalizePlatform,
  relationTypeForRole,
} from "./profile-hints.ts";

describe("cleanName", () => {
  it("strips quotes and collapses whitespace", () => {
    expect(cleanName(`  "John"  Doe  `)).toBe("John Doe");
  });

  it("rejects short, long, and placeholder names", () => {
    expect(cleanName("a")).toBeNull();
    expect(cleanName("x".repeat(81))).toBeNull();
    expect(cleanName("me")).toBeNull();
    expect(cleanName("someone")).toBeNull();
  });
});

describe("cleanHandle", () => {
  it("trims trailing punctuation", () => {
    expect(cleanHandle("@johndoe,")).toBe("@johndoe");
    expect(cleanHandle("johndoe!")).toBe("johndoe");
  });

  it("rejects empty or short handles", () => {
    expect(cleanHandle("")).toBeNull();
    expect(cleanHandle("a")).toBeNull();
  });
});

describe("normalizePlatform", () => {
  it("maps twitter to x and lowercases", () => {
    expect(normalizePlatform("Twitter")).toBe("x");
    expect(normalizePlatform("DISCORD")).toBe("discord");
  });
});

describe("relationTypeForRole", () => {
  it("maps known roles", () => {
    expect(relationTypeForRole("boss")).toBe("managed_by");
    expect(relationTypeForRole("spouse")).toBe("partner_of");
    expect(relationTypeForRole("Friend")).toBe("knows");
  });

  it("falls back to the lowercased role", () => {
    expect(relationTypeForRole("Accountant")).toBe("accountant");
  });

  it("handles null", () => {
    expect(relationTypeForRole(null)).toBeNull();
  });
});
