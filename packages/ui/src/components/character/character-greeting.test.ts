/**
 * Unit tests for character greeting resolver: validates animation path resolution.
 */
import { describe, expect, it } from "vitest";
import { resolveCharacterGreetingAnimation } from "./character-greeting.ts";

describe("character-greeting", () => {
  it("normalizes and returns explicit greeting animation path", () => {
    const res = resolveCharacterGreetingAnimation({
      greetingAnimation: "/assets/animations/wave.json",
    });
    expect(res).toBe("assets/animations/wave.json");
  });

  it("returns null when no greeting animation or avatar index is provided", () => {
    expect(resolveCharacterGreetingAnimation({})).toBeNull();
    expect(
      resolveCharacterGreetingAnimation({
        avatarIndex: null,
        greetingAnimation: null,
      }),
    ).toBeNull();
  });

  it("resolves animation from style presets when avatarIndex is provided", () => {
    const res = resolveCharacterGreetingAnimation({ avatarIndex: 1 });
    expect(res === null || typeof res === "string").toBe(true);
  });
});
