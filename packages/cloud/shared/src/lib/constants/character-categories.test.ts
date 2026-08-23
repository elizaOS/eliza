/**
 * Coverage for character-categories.
 */
import { describe, expect, it } from "vitest";
import { CHARACTER_CATEGORIES, getCategoryById, isCategoryId } from "./character-categories.js";

describe("character-categories", () => {
  it("validates category id", () => {
    expect(isCategoryId("assistant")).toBe(true);
    expect(isCategoryId("unknown")).toBe(false);
  });
  it("gets category", () => {
    expect(getCategoryById("assistant")?.name).toBe("Assistants");
    expect(getCategoryById("gaming" as any)?.id).toBe("gaming");
  });
  it("exposes categories", () => {
    expect(CHARACTER_CATEGORIES.ASSISTANT.id).toBe("assistant");
  });
});
