/**
 * System memory reader — the single source of "how much RAM can we actually
 * allocate right now" for the local-inference memory arbiter and pressure
 * sources.
 *
 * Node's `os.freemem()` returns the kernel's `MemFree` on Linux, which counts
 * only never-touched pages and EXCLUDES reclaimable page cache + slab. On
 * Android — where the app process runs under a large page cache — `MemFree`
 * undercounts allocatable memory by gigabytes, so a `MemFree`-driven arbiter
 * evicts models it didn't need to and refuses loads that would have fit.
 *
 * `/proc/meminfo`'s `MemAvailable` is the kernel's own estimate of how much
 * memory is available for starting new applications without swapping (free +
 * reclaimable cache/slab, minus the low watermark). That is exactly the number
 * the arbiter wants. Read it on Linux/Android.
 *
 * macOS has the same undercount, worse: `os.freemem()` maps to Mach "Pages
 * free" only, and the kernel deliberately keeps that near zero by holding
 * reclaimable file cache in the inactive/speculative/purgeable lists. On a
 * healthy 128 GB Mac, `freemem()` routinely reports < 5% while the kernel's
 * own `memory_pressure` tool reports > 80% free — which tripped the arbiter's
 * critical-pressure gate and made it refuse every non-text capability
 * (vision-describe, ASR, TTS, image-gen). Read `vm_stat` and count
 * free + inactive + speculative + purgeable pages as available instead.
 *
 * Windows falls back to `os.freemem()` / `os.totalmem()` (which maps to
 * `ullAvailPhys` there — already an availability metric).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";

export interface SystemMemory {
	freeBytes: number;
	totalBytes: number;
}

/** Injectable for tests: returns the raw `/proc/meminfo` text, or null. */
export type MeminfoReader = () => string | null;

const defaultMeminfoReader: MeminfoReader = () => {
	if (os.platform() !== "linux") return null;
	try {
		return readFileSync("/proc/meminfo", "utf8");
	} catch {
		return null;
	}
};

function parseMeminfoKb(text: string, key: string): number | null {
	// Lines look like: "MemAvailable:   12345678 kB"
	const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
	if (!match) return null;
	const kb = Number.parseInt(match[1], 10);
	return Number.isFinite(kb) ? kb : null;
}

/** Injectable for tests: returns the raw `vm_stat` output text, or null. */
export type VmStatReader = () => string | null;

const defaultVmStatReader: VmStatReader = () => {
	if (os.platform() !== "darwin") return null;
	try {
		return execFileSync("/usr/bin/vm_stat", {
			encoding: "utf8",
			timeout: 2_000,
		});
	} catch {
		return null;
	}
};

/**
 * Parse macOS `vm_stat` output into available bytes:
 * (free + inactive + speculative + purgeable) × page size. Inactive and
 * speculative pages are the reclaimable file cache; purgeable is memory the
 * owner volunteered to give back. This mirrors what Linux `MemAvailable`
 * counts and is conservative relative to the kernel's own
 * `memory_pressure` "free percentage".
 */
function parseVmStatAvailableBytes(text: string): number | null {
	const pageSizeMatch = /page size of (\d+) bytes/.exec(text);
	const pageSize = pageSizeMatch ? Number.parseInt(pageSizeMatch[1], 10) : NaN;
	if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
	const pages = (label: string): number | null => {
		// Lines look like: `Pages free:                              462821.`
		const match = new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(text);
		if (!match) return null;
		const n = Number.parseInt(match[1], 10);
		return Number.isFinite(n) ? n : null;
	};
	const free = pages("Pages free");
	const inactive = pages("Pages inactive");
	if (free === null || inactive === null) return null;
	const speculative = pages("Pages speculative") ?? 0;
	const purgeable = pages("Pages purgeable") ?? 0;
	return (free + inactive + speculative + purgeable) * pageSize;
}

/**
 * Read available + total system memory in bytes. Prefers `/proc/meminfo`
 * `MemAvailable`/`MemTotal` on Linux and `vm_stat` reclaimable-page math on
 * macOS; falls back to `os.freemem()/totalmem()`.
 *
 * @param read injectable meminfo reader (tests). Defaults to reading
 *   `/proc/meminfo` on Linux and returning null elsewhere.
 * @param readVmStat injectable vm_stat reader (tests). Defaults to running
 *   `/usr/bin/vm_stat` on macOS and returning null elsewhere.
 * @param totalMem injectable total-memory source (tests). Defaults to
 *   `os.totalmem`.
 */
export function readSystemMemory(
	read: MeminfoReader = defaultMeminfoReader,
	readVmStat: VmStatReader = defaultVmStatReader,
	totalMem: () => number = os.totalmem,
): SystemMemory {
	const text = read();
	if (text) {
		const availKb = parseMeminfoKb(text, "MemAvailable");
		const totalKb = parseMeminfoKb(text, "MemTotal");
		if (availKb !== null && totalKb !== null && totalKb > 0) {
			return { freeBytes: availKb * 1024, totalBytes: totalKb * 1024 };
		}
	}
	const vmStatText = readVmStat();
	if (vmStatText) {
		const availBytes = parseVmStatAvailableBytes(vmStatText);
		const totalBytes = totalMem();
		if (availBytes !== null && totalBytes > 0) {
			return { freeBytes: Math.min(availBytes, totalBytes), totalBytes };
		}
	}
	return { freeBytes: os.freemem(), totalBytes: totalMem() };
}
