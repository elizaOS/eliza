/**
 * Pins the narrow Stage-1 route: explicit Aomi mentions route, generic crypto
 * questions remain available to the rest of elizaOS.
 */
import { describe, expect, it } from "vitest";
import { looksLikeExplicitAomiRequest } from "./routing.js";

describe("Aomi direct routing", () => {
  it.each([
    "Use Aomi to research lending rates.",
    "ask AOMI to explain this protocol",
    "Can aomi prepare the transaction?",
  ])("matches an explicit Aomi request: %s", (text) => {
    expect(looksLikeExplicitAomiRequest(text)).toBe(true);
  });

  it.each([
    "What is the ETH price?",
    "Send 0.1 ETH to my friend.",
    "Explain how lending protocols work.",
  ])("does not claim generic crypto traffic: %s", (text) => {
    expect(looksLikeExplicitAomiRequest(text)).toBe(false);
  });
});
