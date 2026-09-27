import { describe, expect, it } from "vitest";
import { isPrivateIpAddress } from "./ssrf";

describe("isPrivateIpAddress NAT64 local-use prefix (RFC 8215)", () => {
	it.each([
		"64:ff9b:1::a9fe:a9fe",
		"64:ff9b:1::7f00:1",
		"64:ff9b:1:abcd::a9fe:a9fe",
		"64:ff9b:1:0:a:0:100:0",
		"64:ff9b:1:a00:1::",
		"64:ff9b:1::808:808",
	])("blocks %s", (address) => {
		expect(isPrivateIpAddress(address)).toBe(true);
	});

	it("still allows addresses outside both NAT64 prefixes", () => {
		expect(isPrivateIpAddress("64:ff9b:2::a9fe:a9fe")).toBe(false);
		expect(isPrivateIpAddress("64:ff9b::808:808")).toBe(false);
	});
});
