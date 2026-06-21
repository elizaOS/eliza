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
 * the arbiter wants. Read it on Linux/Android; fall back to `os.freemem()` /
 * `os.totalmem()` everywhere else (macOS, Windows) or if `/proc/meminfo` is
 * unreadable or pre-3.14 (no `MemAvailable`).
 */

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

/**
 * Read available + total system memory in bytes. Prefers `/proc/meminfo`
 * `MemAvailable`/`MemTotal` on Linux; falls back to `os.freemem()/totalmem()`.
 *
 * @param read injectable meminfo reader (tests). Defaults to reading
 *   `/proc/meminfo` on Linux and returning null elsewhere.
 */
export function readSystemMemory(
	read: MeminfoReader = defaultMeminfoReader,
): SystemMemory {
	const text = read();
	if (text) {
		const availKb = parseMeminfoKb(text, "MemAvailable");
		const totalKb = parseMeminfoKb(text, "MemTotal");
		if (availKb !== null && totalKb !== null && totalKb > 0) {
			return { freeBytes: availKb * 1024, totalBytes: totalKb * 1024 };
		}
	}
	return { freeBytes: os.freemem(), totalBytes: os.totalmem() };
}
