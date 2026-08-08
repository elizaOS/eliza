/**
 * Storage-mode policy for PGlite-backed test runtimes. In-memory WASM storage
 * (a `memory://` data dir) is the default: it exercises the same Postgres
 * engine, extensions, and schema migrations as a disk data dir while avoiding
 * Emscripten NODEFS writes to the host tmp filesystem, which fault mid-suite
 * on loaded CI runners (WASI EBADF/ENOENT, `could not seek to end of file`,
 * elizaOS/eliza#18053). Suites that prove restart persistence create a real
 * directory themselves and pass it explicitly; setting
 * `ELIZA_TEST_PGLITE_STORAGE=disk` forces temp-directory storage everywhere
 * as a diagnostic escape hatch.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type TestPgliteStorageMode = "memory" | "disk";

let memoryDataDirSequence = 0;

/** Resolves the storage mode from `ELIZA_TEST_PGLITE_STORAGE` (default: memory). */
export function testPgliteStorageMode(): TestPgliteStorageMode {
	const mode = process.env.ELIZA_TEST_PGLITE_STORAGE;
	if (mode === undefined || mode === "" || mode === "memory") {
		return "memory";
	}
	if (mode === "disk") {
		return "disk";
	}
	throw new Error(
		`ELIZA_TEST_PGLITE_STORAGE must be "memory" or "disk", got "${mode}"`,
	);
}

/** True when the data dir is PGlite's in-memory URL form (no host filesystem). */
export function isInMemoryPgliteDataDir(dataDir: string): boolean {
	return dataDir.startsWith("memory://");
}

/**
 * Allocates a PGlite data dir for one test runtime: a unique `memory://` URL
 * in memory mode, or a fresh temp directory in disk mode. Uniqueness matters
 * even in memory mode — plugin-sql caches managers per (dataDir, agentId), so
 * a shared URL would alias two concurrently open runtimes onto one database.
 * Disk-mode callers own removal of the returned directory.
 */
export function createTestPgliteDataDir(prefix: string): string {
	if (testPgliteStorageMode() === "memory") {
		memoryDataDirSequence += 1;
		return `memory://${prefix}${process.pid}-${memoryDataDirSequence}`;
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
