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
    "Hey, can you use computer use to open Telegram?",
    "I need you to use computer use to take a screenshot",
    "I want u to use my computer to open Finder",
    "please, use computer use to open Telegram",
    "I would like you to use computer use to open Telegram",
    "hey please can you use computer use to open Telegram",
  ])("recognizes an explicit host-control request: %s", (text) => {
    expect(looksLikeExplicitComputerUseRequest(text)).toBe(true);
  });

  it.each([
    "open telegram",
    "open telegram in the browser",
    "tell me what computer use means",
    "do not use the computer",
    "do not use computer use to open Telegram",
    "never ever use computer use to take a screenshot",
    "do not, under any circumstances, use computer use to open Telegram",
    "don’t use computer use to open Telegram",
    "use computer use to not open Telegram",
    "use computer use, but do not open Telegram",
    "use computer use? Actually, do not open Telegram",
    "use computer use. On second thought, cancel that request",
    'please explain why "use computer use to take a screenshot" is unsafe',
    "please explain why `use computer use to open Telegram` is unsafe",
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
      unavailable: {
        code: "COMPUTER_USE_UNAVAILABLE",
        reply: expect.stringContaining("restart the app session"),
      },
    });
  });
});
