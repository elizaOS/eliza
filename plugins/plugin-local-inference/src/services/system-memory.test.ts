import { describe, expect, it } from "vitest";
import { readSystemMemory } from "./system-memory.js";

const SAMPLE_MEMINFO = `MemTotal:       16277856 kB
MemFree:          812044 kB
MemAvailable:   10342988 kB
Buffers:          204512 kB
Cached:          7651200 kB
SwapTotal:             0 kB
`;

describe("readSystemMemory", () => {
	it("prefers MemAvailable + MemTotal from /proc/meminfo", () => {
		const mem = readSystemMemory(() => SAMPLE_MEMINFO);
		expect(mem.totalBytes).toBe(16_277_856 * 1024);
		// MemAvailable (10.3 GB), NOT MemFree (0.8 GB) — the whole point.
		expect(mem.freeBytes).toBe(10_342_988 * 1024);
	});

	it("does not regress to MemFree when reclaimable cache is large", () => {
		const mem = readSystemMemory(() => SAMPLE_MEMINFO);
		const memFreeBytes = 812_044 * 1024;
		expect(mem.freeBytes).toBeGreaterThan(memFreeBytes * 10);
	});

	it("falls back to os when the reader returns null (non-Linux)", () => {
		const mem = readSystemMemory(() => null);
		expect(mem.totalBytes).toBeGreaterThan(0);
		expect(mem.freeBytes).toBeGreaterThan(0);
		expect(mem.freeBytes).toBeLessThanOrEqual(mem.totalBytes);
	});

	it("falls back to os when MemAvailable is absent (pre-3.14 kernel)", () => {
		const noAvail = "MemTotal:  16277856 kB\nMemFree:  812044 kB\n";
		const mem = readSystemMemory(() => noAvail);
		// No MemAvailable → os fallback, so freeBytes is the live os.freemem(),
		// not the parsed MemFree.
		expect(mem.totalBytes).toBeGreaterThan(0);
		expect(mem.freeBytes).toBeGreaterThan(0);
	});

	it("falls back to os on malformed meminfo", () => {
		const mem = readSystemMemory(() => "garbage\nnot meminfo\n");
		expect(mem.totalBytes).toBeGreaterThan(0);
		expect(mem.freeBytes).toBeGreaterThan(0);
	});
});
