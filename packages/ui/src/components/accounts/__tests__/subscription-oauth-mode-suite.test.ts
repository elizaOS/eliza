/**
 * Unit tests for browser subscription OAuth mode resolution.
 * Validates localhost vs device mode derivation for loopback and remote hostnames.
 */
import { describe, expect, it } from "vitest";
import { subscriptionOAuthModeForHostname } from "../subscription-oauth-mode.ts";

describe("subscription-oauth-mode", () => {
  it("returns localhost mode for standard localhost hostnames", () => {
    expect(subscriptionOAuthModeForHostname("localhost")).toBe("localhost");
    expect(subscriptionOAuthModeForHostname("LOCALHOST")).toBe("localhost");
    expect(subscriptionOAuthModeForHostname("  localhost  ")).toBe("localhost");
  });

  it("returns localhost mode for IPv4 and IPv6 loopback addresses with and without brackets", () => {
    expect(subscriptionOAuthModeForHostname("127.0.0.1")).toBe("localhost");
    expect(subscriptionOAuthModeForHostname("::1")).toBe("localhost");
    expect(subscriptionOAuthModeForHostname("[::1]")).toBe("localhost");
  });

  it("returns device mode for remote and staging hostnames", () => {
    expect(subscriptionOAuthModeForHostname("eliza.app")).toBe("device");
    expect(subscriptionOAuthModeForHostname("staging.eliza.app")).toBe(
      "device",
    );
    expect(subscriptionOAuthModeForHostname("192.168.1.100")).toBe("device");
    expect(subscriptionOAuthModeForHostname("custom-domain.internal")).toBe(
      "device",
    );
  });
});
