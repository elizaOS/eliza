import { describe, expect, it } from "vitest";
import { DESK_VERSION, newerRelease, WHATS_NEW } from "../src/updates.ts";

describe("desktop updates", () => {
  it("notices a newer tag and keeps the current notes", () => {
    expect(newerRelease("0.1.1", "v0.1.2")).toBe(true);
    expect(newerRelease("0.1.1", "v0.1.1")).toBe(false);
    expect(newerRelease(DESK_VERSION, "v0.1.0")).toBe(false);
    expect(WHATS_NEW.join(" ")).toMatch(/Self-repair/);
    expect(WHATS_NEW.join(" ")).not.toMatch(/withdraw funds|seed phrase/);
  });
});
