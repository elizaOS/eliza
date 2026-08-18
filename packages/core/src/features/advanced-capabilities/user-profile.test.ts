/**
 * User-profile timezone/location persistence tests: explicit values are
 * never clobbered by learned ones, learned values replace learned values
 * (latest wins), invalid IANA zones are dropped, and everything degrades
 * to no-ops instead of throwing.
 */
import { describe, expect, it } from "vitest";
import type { Entity, IAgentRuntime, UUID } from "../../types/index.ts";
import {
	learnUserProfileFromStructuredFields,
	readUserProfile,
	validIanaTimeZone,
} from "./user-profile.ts";

const ENTITY_ID = "6f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b" as UUID;
const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;

function entity(metadata?: Record<string, unknown>): Entity {
	return {
		id: ENTITY_ID,
		names: ["Shadow"],
		agentId: AGENT_ID,
		...(metadata ? { metadata } : {}),
	} as Entity;
}

function runtimeWith(stored: Entity | null): {
	runtime: IAgentRuntime;
	updates: Entity[];
} {
	const updates: Entity[] = [];
	const runtime = {
		getEntityById: async () => stored,
		updateEntity: async (next: Entity) => {
			updates.push(next);
		},
	} as unknown as IAgentRuntime;
	return { runtime, updates };
}

describe("validIanaTimeZone", () => {
	it("accepts real zones and rejects junk", () => {
		expect(validIanaTimeZone("America/New_York")).toBe("America/New_York");
		expect(validIanaTimeZone("  Asia/Tokyo ")).toBe("Asia/Tokyo");
		expect(validIanaTimeZone("Mars/Olympus_Mons")).toBeNull();
		expect(validIanaTimeZone("")).toBeNull();
		expect(validIanaTimeZone(42)).toBeNull();
	});
});

describe("readUserProfile", () => {
	it("reads the canonical userProfile object", () => {
		const profile = readUserProfile(
			entity({
				userProfile: {
					timezone: "America/New_York",
					timezoneSource: "learned",
					location: "Brooklyn, NYC",
				},
			}),
		);
		expect(profile.timezone).toBe("America/New_York");
		expect(profile.timezoneSource).toBe("learned");
		expect(profile.location).toBe("Brooklyn, NYC");
		// location without a stored source defaults to explicit (hand-set)
		expect(profile.locationSource).toBe("explicit");
	});

	it("treats legacy flat metadata keys as explicit and lets them win", () => {
		const profile = readUserProfile(
			entity({
				timezone: "America/Denver",
				userProfile: { timezone: "Asia/Tokyo", timezoneSource: "learned" },
			}),
		);
		expect(profile.timezone).toBe("America/Denver");
		expect(profile.timezoneSource).toBe("explicit");
	});

	it("drops invalid stored timezones", () => {
		const profile = readUserProfile(
			entity({ userProfile: { timezone: "Not/AZone" } }),
		);
		expect(profile.timezone).toBeUndefined();
	});

	it("returns empty for missing entities and metadata", () => {
		expect(readUserProfile(null)).toEqual({});
		expect(readUserProfile(entity())).toEqual({});
	});
});

describe("learnUserProfileFromStructuredFields", () => {
	it("persists a learned timezone and location onto the entity", async () => {
		const { runtime, updates } = runtimeWith(entity());
		const wrote = await learnUserProfileFromStructuredFields(
			runtime,
			ENTITY_ID,
			{ timezone: "America/New_York", city: "Brooklyn" },
		);
		expect(wrote).toBe(true);
		expect(updates).toHaveLength(1);
		const profile = readUserProfile(updates[0]);
		expect(profile.timezone).toBe("America/New_York");
		expect(profile.timezoneSource).toBe("learned");
		expect(profile.location).toBe("Brooklyn");
		expect(profile.locationSource).toBe("learned");
	});

	it("never overwrites an explicit value with a learned one", async () => {
		const { runtime, updates } = runtimeWith(
			entity({
				userProfile: {
					timezone: "America/New_York",
					timezoneSource: "explicit",
				},
			}),
		);
		const wrote = await learnUserProfileFromStructuredFields(
			runtime,
			ENTITY_ID,
			{ timezone: "Europe/London" },
		);
		expect(wrote).toBe(false);
		expect(updates).toHaveLength(0);
	});

	it("replaces a previously learned value with a newer learned one", async () => {
		const { runtime, updates } = runtimeWith(
			entity({
				userProfile: {
					timezone: "America/Denver",
					timezoneSource: "learned",
				},
			}),
		);
		const wrote = await learnUserProfileFromStructuredFields(
			runtime,
			ENTITY_ID,
			{ ianaTimezone: "America/New_York" },
		);
		expect(wrote).toBe(true);
		const profile = readUserProfile(updates[0]);
		expect(profile.timezone).toBe("America/New_York");
		expect(profile.timezoneSource).toBe("learned");
	});

	it("ignores invalid timezones and empty fields", async () => {
		const { runtime, updates } = runtimeWith(entity());
		expect(
			await learnUserProfileFromStructuredFields(runtime, ENTITY_ID, {
				timezone: "Mars/Olympus_Mons",
			}),
		).toBe(false);
		expect(
			await learnUserProfileFromStructuredFields(runtime, ENTITY_ID, {}),
		).toBe(false);
		expect(
			await learnUserProfileFromStructuredFields(
				runtime,
				ENTITY_ID,
				undefined,
			),
		).toBe(false);
		expect(updates).toHaveLength(0);
	});

	it("no-ops when the entity does not exist or lookups throw", async () => {
		const { runtime } = runtimeWith(null);
		expect(
			await learnUserProfileFromStructuredFields(runtime, ENTITY_ID, {
				timezone: "America/New_York",
			}),
		).toBe(false);

		const throwing = {
			getEntityById: async () => {
				throw new Error("db down");
			},
			updateEntity: async () => {},
		} as unknown as IAgentRuntime;
		expect(
			await learnUserProfileFromStructuredFields(throwing, ENTITY_ID, {
				timezone: "America/New_York",
			}),
		).toBe(false);
	});
});
