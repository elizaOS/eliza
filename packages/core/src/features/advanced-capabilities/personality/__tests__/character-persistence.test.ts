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
});

describe("CHARACTER_PERSISTENCE_SERVICE", () => {
	it("matches the service token convention", () => {
		expect(CHARACTER_PERSISTENCE_SERVICE).toBe("eliza_character_persistence");
	});
});
