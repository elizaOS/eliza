/**
 * Verifies that automatic pairing token issuance is limited to the agent
 * origin, with origin-less requests accepted only from the loopback socket.
 */
import { describe, expect, it } from "vitest";
import { isBrowserAutoPairOriginAllowed } from "./bridge.js";

describe("browser auto-pair origin policy", () => {
  const agentOrigin = "http://127.0.0.1:31337";

  it("allows the agent origin and origin-less loopback requests", () => {
    expect(
      isBrowserAutoPairOriginAllowed(agentOrigin, agentOrigin, false),
    ).toBe(true);
    expect(isBrowserAutoPairOriginAllowed("", agentOrigin, true)).toBe(true);
  });

  it("rejects origin-less remote requests", () => {
    expect(isBrowserAutoPairOriginAllowed("", agentOrigin, false)).toBe(false);
  });

  it.each([
    "chrome-extension://attacker",
    "moz-extension://attacker",
    "safari-web-extension://attacker",
    "http://127.0.0.1:31337.attacker.example",
  ])("rejects untrusted origin %s", (origin) => {
    expect(isBrowserAutoPairOriginAllowed(origin, agentOrigin, true)).toBe(
      false,
    );
  });
});
