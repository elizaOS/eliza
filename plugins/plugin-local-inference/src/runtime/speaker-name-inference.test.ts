/** Covers meeting speaker-name inference, provenance, and correction binding. */
import { describe, expect, it } from "vitest";
import { inferSpeakerName } from "./speaker-name-inference.js";

describe("inferSpeakerName", () => {
	it("keeps conflicting platform and calendar names as review candidates", () => {
		const result = inferSpeakerName({
			speakerId: "speaker-1",
			evidence: [
				{
					source: "platform_roster",
					name: "Alex",
					confidence: 0.78,
					evidenceId: "zoom-roster",
				},
				{
					source: "calendar_attendee",
					name: "Alexandra Gray",
					confidence: 0.74,
					evidenceId: "calendar",
				},
			],
		});

		expect(result.resolution).toBe("needs_confirmation");
		expect(result.displayName).toBeUndefined();
		expect(result.reasonCodes).toContain("conflicting_name_evidence");
		expect(result.candidateNames).toHaveLength(2);
		expect(
			result.candidateNames.every(
				(candidate) =>
					candidate.confidence > 0 && candidate.provenance.length > 0,
			),
		).toBe(true);
	});

	it("does not confirm low-confidence inferred names even when sources agree", () => {
		const result = inferSpeakerName({
			speakerId: "speaker-1",
			evidence: [
				{ source: "platform_roster", name: "Ari", confidence: 0.72 },
				{ source: "calendar_attendee", name: "Ari", confidence: 0.74 },
			],
		});

		expect(result.resolution).toBe("needs_confirmation");
		expect(result.displayName).toBeUndefined();
		expect(result.reasonCodes).toContain("source_agreement");
		expect(result.reasonCodes).toContain("low_confidence_name");
	});

	it("withholds self-introduction that conflicts with a borrowed laptop platform label", () => {
		const result = inferSpeakerName({
			speakerId: "speaker-1",
			evidence: [
				{
					source: "platform_roster",
					name: "Taylor Owner",
					confidence: 0.93,
					deviceOwnerEntityId: "entity-device-owner",
				},
				{
					source: "self_introduction",
					name: "Mina Chen",
					confidence: 0.9,
				},
			],
		});

		expect(result.resolution).toBe("withheld");
		expect(result.displayName).toBeUndefined();
		expect(result.reasonCodes).toContain("borrowed_device_guardrail");
		expect(result.bindingPlan.action).toBe("none");
	});

	it("confirms voice-profile matches with entity/profile provenance", () => {
		const result = inferSpeakerName({
			speakerId: "speaker-voice",
			evidence: [
				{
					source: "voice_profile",
					name: "Jon Reed",
					confidence: 0.94,
					entityId: "entity-jon",
					profileId: "profile-jon",
				},
			],
		});

		expect(result.resolution).toBe("confirmed");
		expect(result.displayName).toBe("Jon Reed");
		expect(result.entityId).toBe("entity-jon");
		expect(result.profileId).toBe("profile-jon");
		expect(result.reasonCodes).toContain("voice_profile_match");
		expect(result.bindingPlan).toMatchObject({
			action: "bind_existing_entity",
			entityId: "entity-jon",
			profileId: "profile-jon",
		});
	});

	it("turns recurring Speaker 2 into Sarah after user correction without creating a duplicate entity", () => {
		const result = inferSpeakerName({
			speakerId: "speaker-2",
			imprintClusterId: "cluster-speaker-2",
			existingEntities: [{ entityId: "entity-sarah", displayName: "Sarah" }],
			evidence: [
				{ source: "calendar_attendee", name: "Speaker 2", confidence: 0.45 },
				{ source: "user_correction", name: "Sarah", confidence: 0.99 },
				{ source: "speaker_memory", name: "Sarah", confidence: 0.96 },
			],
		});

		expect(result.resolution).toBe("confirmed");
		expect(result.displayName).toBe("Sarah");
		expect(result.entityId).toBe("entity-sarah");
		expect(result.bindingPlan.action).toBe("bind_existing_entity");
		expect(result.bindingPlan.mergeEntityIds).toEqual([]);
		expect(result.voiceTurnBindingPlan).toEqual({
			text: "This is Sarah.",
			imprintClusterId: "cluster-speaker-2",
			matchConfidence: 0.99,
			matchedEntityId: "entity-sarah",
		});
		expect(result.reasonCodes).toEqual(
			expect.arrayContaining([
				"user_correction_applied",
				"recurring_memory_applied",
			]),
		);
	});

	it("flags duplicate entities after correction instead of creating another Sarah", () => {
		const result = inferSpeakerName({
			speakerId: "speaker-2",
			existingEntities: [
				{ entityId: "entity-sarah-a", displayName: "Sarah" },
				{ entityId: "entity-sarah-b", displayName: "Sarah" },
			],
			evidence: [
				{ source: "user_correction", name: "Sarah", confidence: 0.99 },
			],
		});

		expect(result.resolution).toBe("confirmed");
		expect(result.requiresReview).toBe(true);
		expect(result.bindingPlan.action).toBe("merge_duplicate_entities");
		expect(result.bindingPlan.mergeEntityIds).toEqual([
			"entity-sarah-a",
			"entity-sarah-b",
		]);
		expect(result.bindingPlan.reasonCodes).toContain(
			"duplicate_entity_merge_required",
		);
	});

	it("withholds two same-first-name candidates until disambiguated", () => {
		const result = inferSpeakerName({
			speakerId: "speaker-ambiguous",
			evidence: [
				{
					source: "calendar_attendee",
					name: "Sarah Kim",
					confidence: 0.82,
				},
				{
					source: "voice_profile",
					name: "Sarah Patel",
					confidence: 0.83,
					entityId: "entity-sarah-patel",
				},
			],
		});

		expect(result.resolution).toBe("withheld");
		expect(result.displayName).toBeUndefined();
		expect(result.bindingPlan.action).toBe("none");
		expect(result.reasonCodes).toContain("same_first_name_ambiguity");
	});

	it("withholds confirmed-looking names behind sensitive-attribute guardrails", () => {
		const result = inferSpeakerName({
			speakerId: "speaker-sensitive",
			sensitiveAttributeGuardrail: true,
			evidence: [
				{
					source: "voice_profile",
					name: "Riley",
					confidence: 0.96,
					entityId: "entity-riley",
				},
			],
		});

		expect(result.resolution).toBe("withheld");
		expect(result.displayName).toBeUndefined();
		expect(result.entityId).toBeUndefined();
		expect(result.bindingPlan.action).toBe("none");
		expect(result.reasonCodes).toContain("sensitive_attribute_guardrail");
	});

	it("fails loud on invalid confidence", () => {
		expect(() =>
			inferSpeakerName({
				speakerId: "speaker-bad",
				evidence: [{ source: "voice_profile", name: "Bad", confidence: 1.2 }],
			}),
		).toThrow(/confidence/);
	});
});
