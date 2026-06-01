import { describe, expect, it } from "vitest";
import {
  assertHostAllowed,
  assertUrlAllowed,
  classifyIpLiteral,
  SsrfBlockedError,
} from "../../src/services/ssrf-guard.ts";

describe("ssrf-guard — classifyIpLiteral", () => {
  it("treats loopback IPv4 as loopback (allowed for local verification)", () => {
    expect(classifyIpLiteral("127.0.0.1")).toBe("loopback");
    expect(classifyIpLiteral("127.1.2.3")).toBe("loopback");
  });

  it("treats ::1 and IPv4-mapped loopback as loopback", () => {
    expect(classifyIpLiteral("::1")).toBe("loopback");
    expect(classifyIpLiteral("::ffff:127.0.0.1")).toBe("loopback");
  });

  it("blocks the cloud-metadata IP and link-local range", () => {
    expect(classifyIpLiteral("169.254.169.254")).toBe("blocked");
    expect(classifyIpLiteral("169.254.0.1")).toBe("blocked");
  });

  it("blocks RFC1918 private ranges", () => {
    expect(classifyIpLiteral("10.0.0.1")).toBe("blocked");
    expect(classifyIpLiteral("172.16.5.4")).toBe("blocked");
    expect(classifyIpLiteral("172.31.255.255")).toBe("blocked");
    expect(classifyIpLiteral("192.168.1.1")).toBe("blocked");
  });

  it("does not block public IPv4 just outside private ranges", () => {
    expect(classifyIpLiteral("172.15.0.1")).toBe("allowed");
    expect(classifyIpLiteral("172.32.0.1")).toBe("allowed");
    expect(classifyIpLiteral("8.8.8.8")).toBe("allowed");
    expect(classifyIpLiteral("1.1.1.1")).toBe("allowed");
  });

  it("blocks CGNAT, this-network, and reserved/multicast ranges", () => {
    expect(classifyIpLiteral("0.0.0.0")).toBe("blocked");
    expect(classifyIpLiteral("100.64.0.1")).toBe("blocked");
    expect(classifyIpLiteral("224.0.0.1")).toBe("blocked");
    expect(classifyIpLiteral("255.255.255.255")).toBe("blocked");
  });

  it("blocks IPv6 ULA, link-local, and metadata", () => {
    expect(classifyIpLiteral("fd00::1")).toBe("blocked");
    expect(classifyIpLiteral("fc00::1")).toBe("blocked");
    expect(classifyIpLiteral("fe80::1")).toBe("blocked");
    expect(classifyIpLiteral("fd00:ec2::254")).toBe("blocked");
    expect(classifyIpLiteral("::")).toBe("blocked");
  });

  it("allows a public IPv6 address", () => {
    expect(classifyIpLiteral("2606:4700:4700::1111")).toBe("allowed");
  });
});

describe("ssrf-guard — assertHostAllowed", () => {
  it("allows localhost without a DNS round-trip", async () => {
    await expect(assertHostAllowed("localhost")).resolves.toBeUndefined();
  });

  it("allows a loopback IP literal", async () => {
    await expect(assertHostAllowed("127.0.0.1")).resolves.toBeUndefined();
  });

  it("rejects the cloud-metadata IP literal", async () => {
    await expect(assertHostAllowed("169.254.169.254")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects an RFC1918 IP literal", async () => {
    await expect(assertHostAllowed("10.1.2.3")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });
});

describe("ssrf-guard — assertUrlAllowed", () => {
  it("rejects non-http(s) protocols", async () => {
    await expect(assertUrlAllowed("file:///etc/passwd")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("rejects a URL pointing directly at the metadata endpoint", async () => {
    await expect(
      assertUrlAllowed("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("allows a loopback build URL", async () => {
    await expect(
      assertUrlAllowed("http://127.0.0.1:8080/index.html"),
    ).resolves.toBeUndefined();
  });
});
