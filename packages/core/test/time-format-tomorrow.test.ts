import { describe, expect, it } from "vitest";
import {
	formatRelativeTime,
	formatTimestamp,
} from "../src/utils/time-format.ts";

const HOUR_MS = 3_600_000;

describe("formatRelativeTime Tomorrow / Yesterday symmetry", () => {
	it("reads a future timestamp 24-48h out as Tomorrow, like Yesterday for the past", () => {
		const now = Date.now();
		expect(formatRelativeTime(now + 25 * HOUR_MS)).toBe("Tomorrow");
		expect(formatRelativeTime(now + 47 * HOUR_MS)).toBe("Tomorrow");
		expect(formatRelativeTime(now - 25 * HOUR_MS)).toBe("Yesterday");
		expect(formatRelativeTime(now - 47 * HOUR_MS)).toBe("Yesterday");
	});

	it("keeps the existing day labels around the window", () => {
		const now = Date.now();
		expect(formatRelativeTime(now + 23.5 * HOUR_MS)).toBe("Tomorrow");
		expect(formatRelativeTime(now + 49 * HOUR_MS)).toBe("in 3d");
		expect(formatRelativeTime(now - 49 * HOUR_MS)).toBe("2d ago");
	});

	it("leaves the verbose magnitudes unchanged (ceiled future, floored past)", () => {
		const now = Date.now();
		expect(formatTimestamp(now + 25 * HOUR_MS)).toBe("in 2 days");
		expect(formatTimestamp(now - 25 * HOUR_MS)).toBe("1 day ago");
	});
});
