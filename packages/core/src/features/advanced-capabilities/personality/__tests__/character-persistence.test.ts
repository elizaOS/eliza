/**
 * Exercises character-persistence service detection and retrieval through deterministic unit tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
	CHARACTER_PERSISTENCE_SERVICE,
	getCharacterPersistenceService,
	isCharacterPersistenceService,
} from "../character-persistence.ts";

describe("isCharacterPersistenceService", () => {
	it("accepts objects with a persistCharacter function", () => {
		expect(isCharacterPersistenceService({ persistCharacter: () => {} })).toBe(
			true,
		);
	});

	it("rejects non-objects and missing methods", () => {
		expect(isCharacterPersistenceService(null)).toBe(false);
		expect(isCharacterPersistenceService("x")).toBe(false);
		expect(isCharacterPersistenceService({})).toBe(false);
		expect(isCharacterPersistenceService({ persistCharacter: 5 })).toBe(false);
	});

	it("rejects the remaining primitives and array shapes", () => {
		expect(isCharacterPersistenceService(undefined)).toBe(false);
		expect(isCharacterPersistenceService(42)).toBe(false);
		expect(isCharacterPersistenceService(true)).toBe(false);
		expect(isCharacterPersistenceService([])).toBe(false);
	});

	it("rejects functions even when they carry a persistCharacter property", () => {
		const candidate = (() => {}) as unknown as Record<string, unknown>;
		candidate.persistCharacter = () => {};
		expect(isCharacterPersistenceService(candidate)).toBe(false);
	});

	it("accepts services inherited through the prototype chain", () => {
		const proto = { persistCharacter: () => {} };
		expect(isCharacterPersistenceService(Object.create(proto))).toBe(true);
	});
});

describe("getCharacterPersistenceService", () => {
	it("returns the service when registered with the right shape", () => {
		const service = { persistCharacter: vi.fn() };
		const runtime = { getService: () => service } as never;
		expect(getCharacterPersistenceService(runtime)).toBe(service);
	});

	it("returns null when the service is missing or malformed", () => {
		const runtime = { getService: () => null } as never;
		expect(getCharacterPersistenceService(runtime)).toBeNull();
	});

	it("returns null for every malformed shape the runtime can serve", () => {
		const broken = [undefined, 7, "nope", {}, []] as const;
		for (const candidate of broken) {
			const runtime = { getService: () => candidate } as never;
			expect(getCharacterPersistenceService(runtime)).toBeNull();
		}
	});

	it("looks the service up under the canonical token", () => {
		const getService = vi.fn(() => null);
		const runtime = { getService } as never;
		getCharacterPersistenceService(runtime);
		expect(getService).toHaveBeenCalledTimes(1);
		expect(getService).toHaveBeenCalledWith(CHARACTER_PERSISTENCE_SERVICE);
	});
});

describe("CHARACTER_PERSISTENCE_SERVICE", () => {
	it("matches the service token convention", () => {
		expect(CHARACTER_PERSISTENCE_SERVICE).toBe("eliza_character_persistence");
	});
});
