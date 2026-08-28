import { describe, expect, it, vi } from "vitest";
import {
  assertHostAllowed,
  classifyIpLiteral,
  SsrfBlockedError,
} from "./ssrf-guard.ts";

describe("classifyIpLiteral", () => {
  it("classifies public addresses as allowed", () => {
    expect(classifyIpLiteral("8.8.8.8")).toBe("allowed");
    expect(classifyIpLiteral("1.1.1.1")).toBe("allowed");
    expect(classifyIpLiteral("2606:4700:4700::1111")).toBe("allowed");
  });

  it("classifies loopback as loopback", () => {
    expect(classifyIpLiteral("127.0.0.1")).toBe("loopback");
    expect(classifyIpLiteral("127.255.255.254")).toBe("loopback");
    expect(classifyIpLiteral("::1")).toBe("loopback");
    expect(classifyIpLiteral("::ffff:127.0.0.1")).toBe("loopback");
  });

  it("blocks private and internal ranges", () => {
    expect(classifyIpLiteral("10.0.0.1")).toBe("blocked");
    expect(classifyIpLiteral("172.16.0.1")).toBe("blocked");
    expect(classifyIpLiteral("192.168.1.1")).toBe("blocked");
  });

  it("blocks cloud metadata and link-local", () => {
    expect(classifyIpLiteral("169.254.169.254")).toBe("blocked");
    expect(classifyIpLiteral("169.254.0.1")).toBe("blocked");
    expect(classifyIpLiteral("fe80::1")).toBe("blocked");
  });

  it("blocks ipv6-mapped internal addresses", () => {
    expect(classifyIpLiteral("::ffff:10.0.0.1")).toBe("blocked");
    expect(classifyIpLiteral("::ffff:192.168.1.1")).toBe("blocked");
  });

  it("blocks multicast and unspecified", () => {
    expect(classifyIpLiteral("224.0.0.1")).toBe("blocked");
    expect(classifyIpLiteral("ff02::1")).toBe("blocked");
    expect(classifyIpLiteral("::")).toBe("blocked");
  });

  it("blocks malformed literals", () => {
    expect(classifyIpLiteral("999.1.1.1")).toBe("blocked");
    expect(classifyIpLiteral("not-an-ip")).toBe("blocked");
  });
});

describe("assertHostAllowed", () => {
  it("allows public hostnames via the resolver", async () => {
    const { setHostResolver } = await import("./ssrf-guard.ts");
    setHostResolver(async () => [{ address: "93.184.216.34" }]);
    const pinned = await assertHostAllowed("example.com");
    expect(pinned).toEqual(["93.184.216.34"]);
    setHostResolver();
  });

  it("rejects hostnames resolving to internal addresses", async () => {
    const { setHostResolver } = await import("./ssrf-guard.ts");
    setHostResolver(async () => [{ address: "10.0.0.1" }]);
    await expect(assertHostAllowed("internal.example.com")).rejects.toThrow(
      SsrfBlockedError,
    );
    setHostResolver();
  });

  it("fails closed when DNS resolution fails", async () => {
    const { setHostResolver } = await import("./ssrf-guard.ts");
    setHostResolver(async () => {
      throw new Error("ENOTFOUND");
    });
    await expect(assertHostAllowed("unresolvable.test")).rejects.toThrow(
      SsrfBlockedError,
    );
    setHostResolver();
  });
});
