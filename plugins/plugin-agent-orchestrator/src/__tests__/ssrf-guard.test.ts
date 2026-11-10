/**
 * The orchestrator SSRF guard classified IPv6 literals by their first hextet
 * and by the IPv4-mapped form only. The IPv4/IPv6 transition ranges — NAT64
 * (`64:ff9b::/96`), 6to4 (`2002::/16`), Teredo (`2001:0000::/32`) — embed an
 * IPv4 the network translates the literal to, so a model-controlled URL such
 * as `http://[64:ff9b::a9fe:a9fe]/` sailed through as a public address and
 * reached the cloud-metadata IP (169.254.169.254) on any NAT64/DNS64 path.
 * Core's `packages/core/src/network/ssrf.ts` already screens those embedded
 * addresses; this guard did not. These tests drive the classifier and the
 * URL gate against transition spellings of blocked, loopback, and public
 * IPv4 addresses.
 */

import { describe, expect, it } from "vitest";
import {
  assertUrlAllowed,
  classifyIpLiteral,
  SsrfBlockedError,
} from "../services/ssrf-guard.js";

describe("classifyIpLiteral transition ranges", () => {
  it.each([
    // NAT64 well-known prefix -> cloud metadata / RFC1918
    ["64:ff9b::a9fe:a9fe", "blocked"],
    ["64:ff9b::c0a8:101", "blocked"],
    ["64:ff9b::169.254.169.254", "blocked"],
    // NAT64 local-use prefix 64:ff9b:1::/48 is internal as a whole
    ["64:ff9b:1::a9fe:a9fe", "blocked"],
    ["64:ff9b:1:2:3:4:5:6", "blocked"],
    // 6to4 embeds the IPv4 in bits 16..48
    ["2002:a9fe:a9fe::", "blocked"],
    ["2002:c0a8:101::", "blocked"],
    // Teredo XOR-obfuscates the client IPv4 in the low 32 bits:
    // 0x3fff:0xfdd2 ^ 0xffff:0xffff = 192.0.2.45 (TEST-NET-2)
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "blocked"],
    // IPv4-compatible ::/96 spelling of the metadata IP
    ["::a9fe:a9fe", "blocked"],
  ])("blocks %s", (address, expected) => {
    expect(classifyIpLiteral(address)).toBe(expected);
  });

  it.each([
    // NAT64 spelling of loopback stays loopback (port gate still applies)
    ["64:ff9b::7f00:1", "loopback"],
    // Teredo spelling of loopback: 127.0.0.1 ^ 0xffffffff = 0x80fffffe
    ["2001:0:4136:e378:8000:63bf:80ff:fffe", "loopback"],
  ])("treats %s as loopback", (address, expected) => {
    expect(classifyIpLiteral(address)).toBe(expected);
  });

  it.each([
    // NAT64 / 6to4 spellings of a public IPv4 stay public
    ["64:ff9b::808:808", "allowed"],
    ["2002:808:808::", "allowed"],
  ])("allows %s", (address, expected) => {
    expect(classifyIpLiteral(address)).toBe(expected);
  });

  it("keeps the direct-literal controls", () => {
    expect(classifyIpLiteral("169.254.169.254")).toBe("blocked");
    expect(classifyIpLiteral("::ffff:a9fe:a9fe")).toBe("blocked");
    expect(classifyIpLiteral("8.8.8.8")).toBe("allowed");
    expect(classifyIpLiteral("::1")).toBe("loopback");
    expect(classifyIpLiteral("127.0.0.1")).toBe("loopback");
  });
});

describe("assertUrlAllowed transition ranges", () => {
  it("rejects a NAT64 URL for the metadata IP", async () => {
    await expect(
      assertUrlAllowed("http://[64:ff9b::a9fe:a9fe]/"),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects a 6to4 URL for the metadata IP", async () => {
    await expect(
      assertUrlAllowed("http://[2002:a9fe:a9fe::]/"),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("lets a NAT64 URL for a public IPv4 through validation", async () => {
    await expect(
      assertUrlAllowed("http://[64:ff9b::808:808]/"),
    ).resolves.toBeNull();
  });
});
