import { describe, expect, it } from "vitest";
import { readSystemMemory } from "./system-memory.js";

const SAMPLE_MEMINFO = `MemTotal:       16277856 kB
MemFree:          812044 kB
MemAvailable:   10342988 kB
Buffers:          204512 kB
Cached:          7651200 kB
SwapTotal:             0 kB
`;

// Real M4 Max capture: freemem() saw only "Pages free" (7.2 GiB of 128 GiB,
// under the 5% critical water mark) while the kernel held ~52 GiB of
// reclaimable inactive file cache.
const SAMPLE_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              462821.
Pages active:                           3371849.
Pages inactive:                         3305280.
Pages speculative:                        57490.
Pages throttled:                              0.
Pages wired down:                        446316.
Pages purgeable:                           2266.
"Translation faults":               18052423203.
Pages copy-on-write:                  589493003.
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

	it("counts macOS reclaimable pages from vm_stat, not just Pages free", () => {
		const totalBytes = 128 * 1024 ** 3; // the capture host: 128 GiB M4 Max
		const mem = readSystemMemory(
			() => null,
			() => SAMPLE_VM_STAT,
			() => totalBytes,
		);
		const pageSize = 16384;
		const expected = (462_821 + 3_305_280 + 57_490 + 2_266) * pageSize; // free+inactive+spec+purgeable
		expect(mem.totalBytes).toBe(totalBytes);
		expect(mem.freeBytes).toBe(expected);
		// The whole point: available is far more than the bare free-page count.
		expect(mem.freeBytes).toBeGreaterThan(462_821 * pageSize * 5);
	});

	it("caps vm_stat availability at total memory", () => {
		const totalBytes = 8 * 1024 ** 3;
		const mem = readSystemMemory(
			() => null,
			() => SAMPLE_VM_STAT,
			() => totalBytes,
		);
		expect(mem.freeBytes).toBe(totalBytes);
		expect(mem.totalBytes).toBe(totalBytes);
	});

	it("falls back to os when vm_stat output is malformed", () => {
		const mem = readSystemMemory(
			() => null,
			() => "garbage\nnot vm_stat\n",
		);
		expect(mem.totalBytes).toBeGreaterThan(0);
		expect(mem.freeBytes).toBeGreaterThan(0);
		expect(mem.freeBytes).toBeLessThanOrEqual(mem.totalBytes);
	});

	it("meminfo wins over vm_stat when both are present (Linux path untouched)", () => {
		const mem = readSystemMemory(
			() => SAMPLE_MEMINFO,
			() => SAMPLE_VM_STAT,
		);
		expect(mem.freeBytes).toBe(10_342_988 * 1024);
		expect(mem.totalBytes).toBe(16_277_856 * 1024);
	});
});
