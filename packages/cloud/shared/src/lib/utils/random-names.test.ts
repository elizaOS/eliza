/**
 * Coverage for random-names.
 */
import { describe, expect, it } from "vitest";
import { generateDisplayName, generateRandomName } from "./random-names.js";

describe("random-names", () => {
  it("generates name", () => {
    const name = generateRandomName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
  });
  it("generates display name", () => {
    expect(generateDisplayName()).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });
  it("is string", () => {
    expect(typeof generateRandomName()).toBe("string");
  });
});
