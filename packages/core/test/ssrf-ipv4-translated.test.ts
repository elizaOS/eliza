import { describe, expect, it } from "vitest";
import { isPrivateIpAddress } from "../src/network/ssrf.ts";

describe("RFC 6145 IPv4-translated addresses", () => {
	it.each([
		["::ffff:0:a9fe:a9fe", true],
		["::ffff:0:7f00:1", true],
		["::ffff:0:808:808", false],
	])("classifies %s as private=%s", (address, isPrivate) => {
		expect(isPrivateIpAddress(address)).toBe(isPrivate);
	});
});
