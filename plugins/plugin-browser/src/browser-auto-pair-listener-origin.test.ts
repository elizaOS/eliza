/**
 * Verifies that automatic pairing advertises the actual local listener rather
 * than request-controlled Host or forwarding headers.
 */
import type http from "node:http";
import { describe, expect, it } from "vitest";
import { resolveBrowserBridgeLocalApiOrigin } from "./plugin.js";

describe("browser auto-pair listener origin", () => {
  it("ignores Host and forwarded-header spoofing", () => {
    const request = {
      headers: {
        host: "attacker.example",
        "x-forwarded-host": "forwarded.attacker.example",
        "x-forwarded-proto": "https",
      },
      socket: {
        localPort: 31337,
      },
    } as http.IncomingMessage;

    expect(resolveBrowserBridgeLocalApiOrigin(request)).toBe(
      "http://127.0.0.1:31337",
    );
  });

  it("fails closed before the listener exposes a concrete port", () => {
    const request = {
      headers: { host: "127.0.0.1:31337" },
      socket: {},
    } as http.IncomingMessage;

    expect(resolveBrowserBridgeLocalApiOrigin(request)).toBeNull();
  });

  it("keeps an IPv6-only loopback listener reachable", () => {
    const request = {
      headers: {},
      socket: {
        localAddress: "::1",
        localPort: 31337,
      },
    } as http.IncomingMessage;

    expect(resolveBrowserBridgeLocalApiOrigin(request)).toBe(
      "http://[::1]:31337",
    );
  });
});
