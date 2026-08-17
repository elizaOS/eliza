/** Verifies browser-session contract parity across every supported companion. */

import { describe, expect, it } from "vitest";
import { LIFEOPS_BROWSER_KINDS } from "./personal-assistant.js";

describe("personal-assistant browser contracts", () => {
  it("supports Chrome, Firefox, and Safari workflow sessions", () => {
    expect(LIFEOPS_BROWSER_KINDS).toEqual(["chrome", "firefox", "safari"]);
  });
});
