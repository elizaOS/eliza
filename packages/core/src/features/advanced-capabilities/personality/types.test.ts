/**
 * Unit tests for personality capability types: the emptyPersonalitySlot
 * factory contract (unset traits, per-call instance freshness, identity
 * passthrough, global-scope wiring) and the canonical value vocabularies
 * consumed by the store validator and action schema enums. Deterministic
 * harness with no mocks.
 */
import { describe, expect, it } from "vitest";
import {
	emptyPersonalitySlot,
	FORMALITY_VALUES,
	GLOBAL_PERSONALITY_SCOPE,
	PersonalityServiceType,
	REPLY_GATE_VALUES,
	SCOPE_VALUES,
	TONE_VALUES,
	TRAIT_VALUES,
	VERBOSITY_VALUES,
} from "./types.ts";

const AGENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_AGENT_ID = "123e4567-e89b-42d3-a456-426614174001";
const USER_ID = "987e6543-e21b-42d3-a456-426614174999";

describe("personality/types", () => {
	describe("emptyPersonalitySlot", () => {
		it("returns a slot with every personality trait unset", () => {
			const slot = emptyPersonalitySlot(USER_ID, AGENT_ID);
			expect(slot.verbosity).toBeNull();
			expect(slot.tone).toBeNull();
			expect(slot.formality).toBeNull();
			expect(slot.reply_gate).toBeNull();
		});

		it("starts with no custom directives and no trait provenance", () => {
			const slot = emptyPersonalitySlot(USER_ID, AGENT_ID);
			expect(slot.custom_directives).toEqual([]);
			expect(slot.trait_sources).toEqual({});
		});

		it("defaults source to an explicit user write and updated_at to the epoch", () => {
			const slot = emptyPersonalitySlot(USER_ID, AGENT_ID);
			expect(slot.source).toBe("user");
			expect(new Date(slot.updated_at).getTime()).toBe(0);
		});

		it("passes user and agent identities through verbatim", () => {
			const slot = emptyPersonalitySlot(USER_ID, AGENT_ID);
			expect(slot.userId).toBe(USER_ID);
			expect(slot.agentId).toBe(AGENT_ID);

			const other = emptyPersonalitySlot(USER_ID, OTHER_AGENT_ID);
			expect(other.userId).toBe(USER_ID);
			expect(other.agentId).toBe(OTHER_AGENT_ID);
		});

		it("addresses the global slot through the exported scope token", () => {
			const slot = emptyPersonalitySlot(GLOBAL_PERSONALITY_SCOPE, AGENT_ID);
			expect(slot.userId).toBe(GLOBAL_PERSONALITY_SCOPE);
			expect(slot.userId).not.toBe(USER_ID);
			expect(slot.agentId).toBe(AGENT_ID);
		});

		it("returns independent instances per call with no shared collections", () => {
			const first = emptyPersonalitySlot(USER_ID, AGENT_ID);
			const second = emptyPersonalitySlot(USER_ID, AGENT_ID);
			expect(first).not.toBe(second);

			first.custom_directives.push("be terser");
			first.trait_sources.tone = "agent_inferred";

			expect(second.custom_directives).toEqual([]);
			expect(second.trait_sources).toEqual({});
			expect(second.source).toBe("user");
		});
	});

	describe("canonical value lists", () => {
		it("exposes non-empty duplicate-free string vocabularies for schema enums", () => {
			for (const values of [
				VERBOSITY_VALUES,
				TONE_VALUES,
				FORMALITY_VALUES,
				REPLY_GATE_VALUES,
				TRAIT_VALUES,
				SCOPE_VALUES,
			]) {
				expect(values.length).toBeGreaterThan(0);
				for (const value of values) {
					expect(typeof value).toBe("string");
				}
				expect(new Set(values).size).toBe(values.length);
			}
		});
	});

	describe("PersonalityServiceType", () => {
		it("registers distinct service type strings under their own keys", () => {
			const entries = Object.entries(PersonalityServiceType);
			expect(entries.length).toBeGreaterThan(0);
			for (const [key, value] of entries) {
				expect(value).toBe(key);
				expect(typeof value).toBe("string");
			}
			expect(new Set(Object.values(PersonalityServiceType)).size).toBe(
				entries.length,
			);
		});
	});
});
