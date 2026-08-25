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
});

describe("isInMemoryPgliteDataDir", () => {
	it("detects memory URLs", () => {
		expect(isInMemoryPgliteDataDir("memory://x-123-1")).toBe(true);
		expect(isInMemoryPgliteDataDir("/tmp/dir")).toBe(false);
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
});
