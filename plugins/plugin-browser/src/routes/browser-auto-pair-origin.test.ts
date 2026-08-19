/**
 * Verifies that automatic pairing token issuance is limited to the agent
 * socket-derived local API origin, with browser-extension and origin-less
 * requests accepted only from the loopback peer.
 */
import { describe, expect, it } from "vitest";
import { isBrowserAutoPairOriginAllowed } from "./bridge.js";

describe("browser auto-pair origin policy", () => {
  const agentOrigin = "http://127.0.0.1:31337";

  it("allows the agent origin and origin-less loopback requests", () => {
    expect(isBrowserAutoPairOriginAllowed(agentOrigin, agentOrigin, true)).toBe(
      true,
    );
    expect(isBrowserAutoPairOriginAllowed("", agentOrigin, true)).toBe(true);
    expect(
      isBrowserAutoPairOriginAllowed(
        "http://localhost:31337",
        agentOrigin,
        true,
      ),
    ).toBe(true);
  });

  it("rejects origin-less remote requests", () => {
    expect(isBrowserAutoPairOriginAllowed("", agentOrigin, false)).toBe(false);
  });

  it.each([
    "chrome-extension://trusted-browser-id",
    "moz-extension://trusted-browser-id",
    "safari-web-extension://trusted-browser-id",
  ])("allows a browser-attested extension origin on loopback: %s", (origin) => {
    expect(isBrowserAutoPairOriginAllowed(origin, agentOrigin, true)).toBe(
      true,
    );
    expect(isBrowserAutoPairOriginAllowed(origin, agentOrigin, false)).toBe(
      false,
    );
  });

  it.each([
    "https://attacker.example",
    "http://localhost:31338",
    "https://localhost:31337",
    "http://127.0.0.1:31337.attacker.example",
    "not an origin",
  ])("rejects untrusted origin %s", (origin) => {
    expect(isBrowserAutoPairOriginAllowed(origin, agentOrigin, true)).toBe(
      false,
    );
  });

  it("fails closed when the server cannot derive its listener origin", () => {
    expect(isBrowserAutoPairOriginAllowed("", null, true)).toBe(false);
  });
});
