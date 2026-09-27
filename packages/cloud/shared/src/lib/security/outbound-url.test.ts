import { describe, expect, test } from "bun:test";
import { isForbiddenIpAddress } from "./outbound-url";

describe("isForbiddenIpAddress NAT64 local-use prefix (RFC 8215)", () => {
  test.each([
    "64:ff9b:1::a9fe:a9fe",
    "64:ff9b:1::7f00:1",
    "64:ff9b:1:abcd::7f00:1",
    "64:ff9b:1:0:a:0:100:0",
    "64:ff9b:1::808:808",
  ])("forbids %s", (address) => {
    expect(isForbiddenIpAddress(address)).toBe(true);
  });

  test("still allows addresses outside both NAT64 prefixes", () => {
    expect(isForbiddenIpAddress("64:ff9b:2::a9fe:a9fe")).toBe(false);
    expect(isForbiddenIpAddress("64:ff9b::808:808")).toBe(false);
  });
});
