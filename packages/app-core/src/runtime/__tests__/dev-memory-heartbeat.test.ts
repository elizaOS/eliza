import { describe, expect, it, vi } from "vitest";
import {
	isRoutineDevMemoryHeartbeatEnabled,
	logRoutineDevMemoryHeartbeat,
} from "./dev-memory-heartbeat.ts";

describe("isRoutineDevMemoryHeartbeatEnabled", () => {
	it("enables only on the exact '1' value", () => {
		expect(isRoutineDevMemoryHeartbeatEnabled("1")).toBe(true);
		expect(isRoutineDevMemoryHeartbeatEnabled("true")).toBe(false);
		expect(isRoutineDevMemoryHeartbeatEnabled(undefined)).toBe(false);
		expect(isRoutineDevMemoryHeartbeatEnabled("")).toBe(false);
	});
});

describe("logRoutineDevMemoryHeartbeat", () => {
	it("formats memory usage in MB at debug level", () => {
		const logger = { debug: vi.fn() };
		logRoutineDevMemoryHeartbeat(logger, "[dev]", {
			rss: 2 * 1048576,
			heapUsed: 1 * 1048576,
			heapTotal: 3 * 1048576,
			external: 512 * 1024,
			arrayBuffers: 256 * 1024,
		} as NodeJS.MemoryUsage);
		expect(logger.debug).toHaveBeenCalledWith(
			"[dev] mem rss=2MB heapUsed=1MB heapTotal=3MB external=1MB arrayBuffers=0MB",
		);
	});

	it("rounds partial MB down", () => {
		const logger = { debug: vi.fn() };
		logRoutineDevMemoryHeartbeat(logger, "x", {
			rss: 1.5 * 1048576,
			heapUsed: 0,
			heapTotal: 0,
			external: 0,
			arrayBuffers: 0,
		} as NodeJS.MemoryUsage);
		expect(logger.debug).toHaveBeenCalledWith(
			"x mem rss=2MB heapUsed=0MB heapTotal=0MB external=0MB arrayBuffers=0MB",
		);
	});
});
