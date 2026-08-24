/**
 * Unit tests for ConfidenceDecayManager: verifies half-life decay,
 * grace period, minConfidence floor, reinforcement boosting,
 * domain/type-specific decay tuning, and confidence trend generation.
 */
import { describe, expect, it } from "vitest";
import type { UUID } from "../../../../types/primitives.ts";
import { type Experience, ExperienceType } from "../types.ts";
import { ConfidenceDecayManager } from "./confidenceDecay.ts";

function createMockExperience(overrides: Partial<Experience> = {}): Experience {
	return {
		id: "11111111-1111-1111-1111-111111111111" as UUID,
		agentId: "22222222-2222-2222-2222-222222222222" as UUID,
		createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
		type: ExperienceType.LEARNING,
		confidence: 0.8,
		importance: 0.7,
		context: { situation: "test situation" },
		action: { type: "test-action" },
		result: { success: true },
		learning: "test learning",
		...overrides,
	};
}

describe("ConfidenceDecayManager", () => {
	it("initializes with default decay configuration", () => {
		const manager = new ConfidenceDecayManager();
		const exp = createMockExperience();
		const decay = manager.getDomainSpecificDecay(exp);
		expect(decay.minConfidence).toBe(0.1);
	});

	it("returns full confidence during grace period", () => {
		const manager = new ConfidenceDecayManager({
			decayStartDelay: 7 * 24 * 60 * 60 * 1000,
		});
		const now = Date.now();
		const freshExp = createMockExperience({
			createdAt: now - 2 * 24 * 60 * 60 * 1000,
			confidence: 0.9,
			type: ExperienceType.SUCCESS,
		});

		const decayed = manager.getDecayedConfidence(freshExp);
		expect(decayed).toBe(0.9);
	});

	it("decays confidence exponentially after grace period", () => {
		const halfLife = 10 * 24 * 60 * 60 * 1000;
		const grace = 5 * 24 * 60 * 60 * 1000;
		const manager = new ConfidenceDecayManager({
			halfLife,
			decayStartDelay: grace,
			minConfidence: 0.05,
		});

		const now = Date.now();
		const exp = createMockExperience({
			createdAt: now - 15 * 24 * 60 * 60 * 1000,
			confidence: 0.8,
			type: ExperienceType.SUCCESS,
		});

		const decayed = manager.getDecayedConfidence(exp);
		expect(decayed).toBeCloseTo(0.4, 3);
	});

	it("respects minimum confidence floor", () => {
		const manager = new ConfidenceDecayManager({
			halfLife: 1000,
			decayStartDelay: 0,
			minConfidence: 0.15,
		});

		const now = Date.now();
		const ancientExp = createMockExperience({
			createdAt: now - 1000000000,
			confidence: 0.9,
			type: ExperienceType.SUCCESS,
		});

		const decayed = manager.getDecayedConfidence(ancientExp);
		expect(decayed).toBe(0.15);
	});

	it("filters experiences needing reinforcement", () => {
		const halfLife = 10 * 24 * 60 * 60 * 1000;
		const manager = new ConfidenceDecayManager({
			halfLife,
			decayStartDelay: 0,
			minConfidence: 0.05,
		});

		const now = Date.now();
		// Initial 0.8 -> decayed to 0.2 (2 half-lives = 20 days)
		const expLow = createMockExperience({
			id: "33333333-3333-3333-3333-333333333333" as UUID,
			createdAt: now - 20 * 24 * 60 * 60 * 1000,
			confidence: 0.8,
			type: ExperienceType.SUCCESS,
		});
		const expHigh = createMockExperience({
			id: "44444444-4444-4444-4444-444444444444" as UUID,
			createdAt: now,
			confidence: 0.9,
			type: ExperienceType.SUCCESS,
		});

		const needing = manager.getExperiencesNeedingReinforcement(
			[expLow, expHigh],
			0.35,
		);
		expect(needing.some((e) => e.id === expLow.id)).toBe(true);
		expect(needing.some((e) => e.id === expHigh.id)).toBe(false);
	});

	it("calculates reinforcement boost bounded at 1.0", () => {
		const manager = new ConfidenceDecayManager();
		const exp = createMockExperience({
			createdAt: Date.now(),
			confidence: 0.6,
			type: ExperienceType.SUCCESS,
		});

		const boosted = manager.calculateReinforcementBoost(exp, 1.0);
		expect(boosted).toBeCloseTo(0.8, 3);

		const maxBoosted = manager.calculateReinforcementBoost(exp, 10.0);
		expect(maxBoosted).toBe(1);
	});

	it("applies domain and type-specific decay configurations", () => {
		const manager = new ConfidenceDecayManager({
			halfLife: 10000,
			minConfidence: 0.1,
		});

		const discExp = createMockExperience({
			type: ExperienceType.DISCOVERY,
		});
		const discConfig = manager.getDomainSpecificDecay(discExp);
		expect(discConfig.halfLife).toBe(20000);

		const warnExp = createMockExperience({
			type: ExperienceType.WARNING,
		});
		const warnConfig = manager.getDomainSpecificDecay(warnExp);
		expect(warnConfig.halfLife).toBe(15000);
		expect(warnConfig.minConfidence).toBe(0.2);

		const secExp = createMockExperience({
			type: ExperienceType.SUCCESS,
			domain: "security",
		});
		const secConfig = manager.getDomainSpecificDecay(secExp);
		expect(secConfig.halfLife).toBe(30000);
		expect(secConfig.minConfidence).toBe(0.3);

		const perfExp = createMockExperience({
			type: ExperienceType.SUCCESS,
			domain: "performance",
		});
		const perfConfig = manager.getDomainSpecificDecay(perfExp);
		expect(perfConfig.halfLife).toBe(5000);

		const prefExp = createMockExperience({
			type: ExperienceType.SUCCESS,
			domain: "user_preference",
		});
		const prefConfig = manager.getDomainSpecificDecay(prefExp);
		expect(prefConfig.halfLife).toBe(7000);
	});

	it("generates confidence trend points over time", () => {
		const manager = new ConfidenceDecayManager();
		const exp = createMockExperience({
			createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
			confidence: 0.8,
			type: ExperienceType.SUCCESS,
		});

		const trend = manager.getConfidenceTrend(exp, 5);
		expect(trend.length).toBe(5);
		expect(trend[0].confidence).toBe(0.8);
		expect(trend[trend.length - 1].confidence).toBeLessThanOrEqual(
			trend[0].confidence,
		);
	});
});
