/**
 * Branch coverage for the PGlite test storage-mode policy in
 * `src/testing/pglite-storage.ts`: env-driven mode resolution, memory-URL
 * detection, and per-runtime data-dir allocation. Deterministic harness; the
 * disk-mode cases touch the real temp filesystem and clean up after
 * themselves. No database is opened.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createTestPgliteDataDir,
	isInMemoryPgliteDataDir,
	testPgliteStorageMode,
} from "../pglite-storage.ts";

const KEY = "ELIZA_TEST_PGLITE_STORAGE";

afterEach(() => {
	delete process.env[KEY];
});

describe("testPgliteStorageMode", () => {
	it("defaults to memory", () => {
		expect(testPgliteStorageMode()).toBe("memory");
		expect(testPgliteStorageMode()).toBe("memory"); // blank also memory
	});

	it("resolves disk", () => {
		process.env[KEY] = "disk";
		expect(testPgliteStorageMode()).toBe("disk");
	});

	it("throws on invalid values", () => {
		process.env[KEY] = "bogus";
		expect(() => testPgliteStorageMode()).toThrow(
			'ELIZA_TEST_PGLITE_STORAGE must be "memory" or "disk"',
		);
	});

	it("treats an empty value as unset", () => {
		process.env[KEY] = "";
		expect(testPgliteStorageMode()).toBe("memory");
	});

	it("accepts an explicit memory value", () => {
		process.env[KEY] = "memory";
		expect(testPgliteStorageMode()).toBe("memory");
	});

	it("reports the offending value when invalid", () => {
		process.env[KEY] = "ram";
		expect(() => testPgliteStorageMode()).toThrow(
			'ELIZA_TEST_PGLITE_STORAGE must be "memory" or "disk", got "ram"',
		);
	});

	it("rejects wrong casing instead of coercing", () => {
		process.env[KEY] = "DISK";
		expect(() => testPgliteStorageMode()).toThrow(
			'ELIZA_TEST_PGLITE_STORAGE must be "memory" or "disk", got "DISK"',
		);
	});
});

describe("isInMemoryPgliteDataDir", () => {
	it("detects memory URLs", () => {
		expect(isInMemoryPgliteDataDir("memory://x-123-1")).toBe(true);
		expect(isInMemoryPgliteDataDir("/tmp/dir")).toBe(false);
	});

	it("treats the bare memory URL as in-memory", () => {
		expect(isInMemoryPgliteDataDir("memory://")).toBe(true);
	});

	it("only matches the prefix at the start of the path", () => {
		expect(isInMemoryPgliteDataDir("/tmp/memory://x")).toBe(false);
	});
});

describe("createTestPgliteDataDir", () => {
	it("allocates unique memory URLs", () => {
		process.env[KEY] = "memory";
		const a = createTestPgliteDataDir("t");
		const b = createTestPgliteDataDir("t");
		expect(isInMemoryPgliteDataDir(a)).toBe(true);
		expect(a).not.toBe(b); // uniqueness for plugin-sql caching
	});

	it("embeds the pid and allocates strictly increasing sequence numbers", () => {
		process.env[KEY] = "memory";
		const first = createTestPgliteDataDir("t");
		const second = createTestPgliteDataDir("t");
		const seqOf = (url: string) => Number(url.slice(url.lastIndexOf("-") + 1));
		expect(first.startsWith(`memory://t${process.pid}-`)).toBe(true);
		expect(second.startsWith(`memory://t${process.pid}-`)).toBe(true);
		expect(seqOf(second)).toBeGreaterThan(seqOf(first));
	});

	it("creates a fresh temp directory on disk in disk mode", () => {
		process.env[KEY] = "disk";
		const dir = createTestPgliteDataDir("eliza-pglite-suite-");
		try {
			expect(fs.statSync(dir).isDirectory()).toBe(true);
			expect(path.basename(dir).startsWith("eliza-pglite-suite-")).toBe(true);
			expect(dir.startsWith(os.tmpdir())).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("gives every disk runtime its own directory", () => {
		process.env[KEY] = "disk";
		const a = createTestPgliteDataDir("eliza-pglite-suite-");
		const b = createTestPgliteDataDir("eliza-pglite-suite-");
		try {
			expect(a).not.toBe(b);
			expect(fs.statSync(a).isDirectory()).toBe(true);
			expect(fs.statSync(b).isDirectory()).toBe(true);
		} finally {
			for (const dir of [a, b]) {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	});
});
