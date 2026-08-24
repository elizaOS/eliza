/**
 * Unit tests for browser API mocks: validates in-memory Storage implementation
 * and Storage API type guard.
 */
import { describe, expect, it } from "vitest";
import { createMemoryStorage, hasStorageApi } from "./browser-mocks.ts";

describe("browser-mocks", () => {
	describe("createMemoryStorage", () => {
		it("implements complete Storage contract in memory", () => {
			const storage = createMemoryStorage();
			expect(storage.length).toBe(0);

			storage.setItem("key1", "val1");
			storage.setItem("key2", "val2");
			expect(storage.length).toBe(2);
			expect(storage.getItem("key1")).toBe("val1");
			expect(storage.getItem("key2")).toBe("val2");
			expect(storage.getItem("missing")).toBeNull();

			expect(storage.key(0)).toBe("key1");
			expect(storage.key(1)).toBe("key2");
			expect(storage.key(99)).toBeNull();

			storage.removeItem("key1");
			expect(storage.length).toBe(1);
			expect(storage.getItem("key1")).toBeNull();

			storage.clear();
			expect(storage.length).toBe(0);
		});
	});

	describe("hasStorageApi", () => {
		it("detects valid Storage implementations", () => {
			const storage = createMemoryStorage();
			expect(hasStorageApi(storage)).toBe(true);
		});

		it("returns false for non-Storage objects", () => {
			expect(hasStorageApi(null)).toBe(false);
			expect(hasStorageApi(undefined)).toBe(false);
			expect(hasStorageApi({})).toBe(false);
			expect(hasStorageApi({ getItem: () => {} })).toBe(false);
		});
	});
});
