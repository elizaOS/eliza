/**
 * Verifies the public runtime host classifier against valid loopback spellings
 * and deceptive or malformed `127.*` names. The cases mirror the shared host
 * contract because core and shared expose the same security decision.
 */

import { describe, expect, it } from "vitest";
import { isLoopbackBindHost } from "./runtime-env";

describe("runtime environment loopback classification", () => {
	it.each([
		"127.0.0.1",
		"127.255.255.255",
		"localhost",
		"::1",
		"[::1]:31337",
		"http://127.0.0.1:31337",
		"::ffff:127.0.0.1",
	])("accepts a valid loopback host: %s", (host) => {
		expect(isLoopbackBindHost(host)).toBe(true);
	});

	it.each([
		"127.evil",
		"127.999.999.999",
		"127.0.0.256",
		"127.0.0.1.evil.example",
		"http://127.999.999.999:31337",
		"http://[::1",
		"192.168.1.1",
		"example.com",
	])("rejects a malformed or remote host: %s", (host) => {
		expect(isLoopbackBindHost(host)).toBe(false);
	});
});
