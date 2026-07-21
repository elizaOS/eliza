import { describe, expect, it } from "vitest";
import { subscriptionOAuthModeForHostname } from "./subscription-oauth-mode";

describe("subscriptionOAuthModeForHostname", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "127.0.0.1",
    "::1",
    "[::1]",
  ])("uses loopback PKCE on %s", (hostname) => {
    expect(subscriptionOAuthModeForHostname(hostname)).toBe("localhost");
  });

  it.each([
    "ovh-eliza.tail4e11f5.ts.net",
    "192.168.1.20",
    "eliza.test",
  ])("uses headless/device auth on %s", (hostname) => {
    expect(subscriptionOAuthModeForHostname(hostname)).toBe("device");
  });
});
