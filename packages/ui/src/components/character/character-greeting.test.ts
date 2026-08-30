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
    expect(resolveCharacterGreetingAnimation({ avatarIndex: 1 })).toBe(
      "animations/greetings/greeting1.fbx.gz",
    );
  });

  it("returns null when avatarIndex is 0", () => {
    expect(resolveCharacterGreetingAnimation({ avatarIndex: 0 })).toBeNull();
  });

  it("returns null when avatarIndex does not match any preset", () => {
    expect(resolveCharacterGreetingAnimation({ avatarIndex: 999 })).toBeNull();
  });
});
