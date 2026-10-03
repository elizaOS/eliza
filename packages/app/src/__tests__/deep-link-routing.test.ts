import { describe, expect, it } from "vitest";
import {
  buildAssistantLaunchHashRoute,
  isTrustedAppLink,
} from "../deep-link-routing";
import {
  isLoopbackApiHost,
  isPrivateOrLoopbackApiHost,
  isTrustedPrivateHttpHost,
} from "../url-trust-policy";

describe("shared app link and host classification", () => {
  it.each([
    ["https://eliza.app/chat", true],
    ["https://child.eliza.app/chat", true],
    ["https://eliza.app.attacker.example/chat", false],
    ["http://eliza.app/chat", false],
    ["https://eliza.app:444/chat", false],
  ])("classifies app link %s", (url, trusted) => {
    expect(isTrustedAppLink(new URL(url), ["eliza.app"])).toBe(trusted);
  });

  it("does not trust app links without a configured host", () => {
    expect(isTrustedAppLink(new URL("https://eliza.app/chat"), undefined)).toBe(
      false,
    );
  });

  it.each(["localhost", "127.0.0.1", "[::1]", "::1"])(
    "recognizes loopback %s",
    (host) => {
      expect(isLoopbackApiHost(host)).toBe(true);
      expect(isPrivateOrLoopbackApiHost(host)).toBe(true);
    },
  );

  it.each(["192.168.1.10", "10.0.0.1", "device.local", "100.64.1.1"])(
    "recognizes private host %s",
    (host) => {
      expect(isTrustedPrivateHttpHost(host)).toBe(true);
      expect(isPrivateOrLoopbackApiHost(host)).toBe(true);
    },
  );

  it("preserves IPv6 local classification without treating public hosts as private", () => {
    expect(isPrivateOrLoopbackApiHost("[fd00::1]")).toBe(true);
    expect(isPrivateOrLoopbackApiHost("[fe80::1]")).toBe(true);
    expect(isPrivateOrLoopbackApiHost("example.com")).toBe(false);
  });

  it("preserves an explicit launch id and text when routing an assistant launch", () => {
    const route = buildAssistantLaunchHashRoute(
      "ask",
      new URLSearchParams("text=hello&assistant.launchId=existing"),
      { now: () => 42, generateLaunchId: () => "new" },
    );
    expect(route).toContain("text=hello");
    expect(route).toContain("assistant.launchId=existing");
    expect(route).toContain("action=ask");
  });
});
