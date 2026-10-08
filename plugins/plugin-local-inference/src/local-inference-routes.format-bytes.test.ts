/**
 * A download total just under 1 GB is still in the megabyte branch, but zero
 * decimals round 1023.999 MB to "1024". The chat progress line must promote
 * that size to gigabytes.
 */
import { describe, expect, it } from "vitest";
import { formatBytes } from "./local-inference-routes.ts";

describe("local inference download size", () => {
	it("promotes a file one byte under 1 GB from 1024 MB to 1.0 GB", () => {
		expect(formatBytes(1024 ** 3 - 1)).toBe("1.0 GB");
	});

	it("keeps sizes that do not round across a unit", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(Math.round(1023.4 * 1024 ** 2))).toBe("1023 MB");
		expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
	});
});
