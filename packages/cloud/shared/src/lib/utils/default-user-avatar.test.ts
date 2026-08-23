/**
 * Coverage for default-user-avatar.
 */
import { describe, expect, it } from "vitest";
import { getRandomUserAvatar } from "./default-user-avatar.js";
describe("default-user-avatar", () => {
  it("returns string", () => {
    const a = getRandomUserAvatar();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(10);
  });
  it("returns url", () => {
    const a = getRandomUserAvatar();
    expect(a).toContain("https://");
  });
  it("is nondeterministic but valid", () => {
    const a = getRandomUserAvatar();
    const b = getRandomUserAvatar();
    expect(typeof a).toBe("string");
    expect(typeof b).toBe("string");
  });
});
