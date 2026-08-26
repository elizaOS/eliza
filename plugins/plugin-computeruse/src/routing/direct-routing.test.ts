/**
 * Exercises the public-language boundary for deterministic Computer Use
 * routing without starting a driver or dispatching host input.
 */
import { describe, expect, it } from "vitest";
import {
  createComputerUseDirectRoutingRule,
  looksLikeExplicitComputerUseRequest,
} from "./direct-routing.js";

describe("Computer Use direct routing", () => {
  it.each([
    "can u use computer use to open telegram",
    "Use Computer-Use to take a screenshot",
    "please use my computer to open Finder",
    "use the computer and show me the desktop",
  ])("recognizes an explicit host-control request: %s", (text) => {
    expect(looksLikeExplicitComputerUseRequest(text)).toBe(true);
  });

  it.each([
    "open telegram",
    "open telegram in the browser",
    "tell me what computer use means",
    "do not use the computer",
  ])("does not hijack an adjacent request: %s", (text) => {
    expect(looksLikeExplicitComputerUseRequest(text)).toBe(false);
  });

  it("owns the exact browser and automation fallbacks from the live failure", () => {
    expect(createComputerUseDirectRoutingRule()).toMatchObject({
      id: "computer-use.explicit-host-control",
      actionNames: ["COMPUTER_USE"],
      replacesActionNames: expect.arrayContaining([
        "BROWSER_NAVIGATE",
        "AUTOMATION_TRIGGER",
      ]),
      requiredActionTags: [
        "domain:computer-use",
        "capability:desktop-control",
        "effect:host-action",
      ],
      contexts: ["automation", "admin"],
    });
  });
});
