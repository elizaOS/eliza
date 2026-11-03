import { describe, expect, it } from "vitest";
import {
  DESK_VERSION,
  hashMatches,
  newerRelease,
  sha256Hex,
  UPDATE_PROMPT,
  WHATS_NEW,
} from "../src/updates.ts";

describe("desktop updates", () => {
  it("notices a newer tag and keeps the current notes", () => {
    expect(newerRelease("0.1.1", "v0.1.2")).toBe(true);
    expect(newerRelease("0.1.1", "v0.1.1")).toBe(false);
    expect(newerRelease(DESK_VERSION, "v0.1.0")).toBe(false);
    expect(WHATS_NEW.join(" ")).toMatch(/Self-repair/);
    expect(WHATS_NEW.join(" ")).not.toMatch(/withdraw funds|seed phrase/);
    expect(UPDATE_PROMPT).toBe("Update ready, restart");
  });

  it("accepts a file only when the SHA-256 matches", () => {
    const bytes = new TextEncoder().encode("valhalla");
    const hash = sha256Hex(bytes);
    expect(hashMatches(hash, hash)).toBe(true);
    expect(hashMatches(hash, "0".repeat(64))).toBe(false);
    expect(hashMatches("short", hash)).toBe(false);
  });
});
