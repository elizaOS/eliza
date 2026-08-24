import { describe, expect, it } from "vitest";
import { isPrivateNetworkHost } from "./private-network-host.js";

describe("isPrivateNetworkHost", () => {
  it("true for localhost and loopback", () => {
    expect(isPrivateNetworkHost("localhost")).toBe(true);
    expect(isPrivateNetworkHost("127.0.0.1")).toBe(true);
    expect(isPrivateNetworkHost("::1")).toBe(true);
    expect(isPrivateNetworkHost("127.1.2.3")).toBe(true);
  });

  it("true for rfc1918 and lan", () => {
    expect(isPrivateNetworkHost("10.0.0.5")).toBe(true);
    expect(isPrivateNetworkHost("192.168.1.1")).toBe(true);
    expect(isPrivateNetworkHost("172.16.5.4")).toBe(true);
    expect(isPrivateNetworkHost("172.31.255.1")).toBe(true);
    expect(isPrivateNetworkHost("100.64.0.1")).toBe(true);
  });

  it("true for .local and .internal suffixes", () => {
    expect(isPrivateNetworkHost("mybox.local")).toBe(true);
    expect(isPrivateNetworkHost("svc.internal")).toBe(true);
  });

  it("false for public hosts", () => {
    expect(isPrivateNetworkHost("8.8.8.8")).toBe(false);
    expect(isPrivateNetworkHost("example.com")).toBe(false);
    expect(isPrivateNetworkHost("172.32.0.1")).toBe(false);
    expect(isPrivateNetworkHost("100.128.0.1")).toBe(false);
  });

  it("handles brackets and case", () => {
    expect(isPrivateNetworkHost("[::1]")).toBe(true);
    expect(isPrivateNetworkHost("LOCALHOST")).toBe(true);
    expect(isPrivateNetworkHost(" MyBox.Local ")).toBe(true);
  });
});
