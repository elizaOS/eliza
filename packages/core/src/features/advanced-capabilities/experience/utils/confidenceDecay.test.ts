/**
 * Unit tests for ConfidenceDecayManager.
 */

import { describe, expect, it } from "vitest";
import { type Experience, ExperienceType } from "../types.js";
import { ConfidenceDecayManager } from "./confidenceDecay.js";

function makeExperience(overrides: Partial<Experience> = {}): Experience {
	return {
		id: "exp-1",
		type: ExperienceType.LEARNING,
		domain: "general",
		title: "Test experience",
		description: "Testing decay behavior",
		confidence: 0.9,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		tags: ["test"],
		metadata: {},
		...overrides,
	};
}

describe("ConfidenceDecayManager", () => {
	it("preserves initial confidence during the grace period", () => {
		const manager = new ConfidenceDecayManager({
			decayStartDelay: 1000 * 60 * 60 * 24 * 7, // 7 days
			halfLife: 1000 * 60 * 60 * 24 * 30, // 30 days
			minConfidence: 0.1,
		});

		const recentExp = makeExperience({
			confidence: 0.85,
			createdAt: Date.now() - 1000 * 60 * 60 * 24 * 3, // 3 days ago
		});

		expect(manager.getDecayedConfidence(recentExp)).toBe(0.85);
	});

	it("decays confidence exponentially after the grace period", () => {
		const manager = new ConfidenceDecayManager({
			decayStartDelay: 1000,
			halfLife: 2000,
			minConfidence: 0.05,
		});

		// Created 3000ms ago -> 1000ms grace period -> 2000ms decay time (1 half-life)
		const exp = makeExperience({
			type: ExperienceType.ACTION_RESULT, // standard decay multiplier 1.0
			domain: "general",
			confidence: 0.8,
			createdAt: Date.now() - 3000,
		});

		const decayed = manager.getDecayedConfidence(exp);
		expect(decayed).toBeCloseTo(0.4, 4); // 0.8 * 0.5^1 = 0.4
	});

	it("respects the configured minimum confidence floor", () => {
		const manager = new ConfidenceDecayManager({
			decayStartDelay: 100,
			halfLife: 100,
			minConfidence: 0.15,
		});

		// Extremely old experience
		const ancientExp = makeExperience({
			confidence: 0.9,
			createdAt: Date.now() - 1000 * 60 * 60 * 24 * 365,
		});

		expect(manager.getDecayedConfidence(ancientExp)).toBe(0.15);
	});

	it("applies domain and type-specific decay modifiers", () => {
		const manager = new ConfidenceDecayManager();

		const securityExp = makeExperience({
			domain: "security",
			type: ExperienceType.DISCOVERY,
		});
		const secConfig = manager.getDomainSpecificDecay(securityExp);
		expect(secConfig.minConfidence).toBe(0.3);
		// DISCOVERY (x2) * security (x3) = 6x halfLife
		expect(secConfig.halfLife).toBe(30 * 24 * 60 * 60 * 1000 * 6);

		const perfExp = makeExperience({
			domain: "performance",
			type: ExperienceType.ACTION_RESULT,
		});
		const perfConfig = manager.getDomainSpecificDecay(perfExp);
		expect(perfConfig.halfLife).toBe(30 * 24 * 60 * 60 * 1000 * 0.5);

		const warningExp = makeExperience({
			type: ExperienceType.WARNING,
			domain: "general",
		});
		const warnConfig = manager.getDomainSpecificDecay(warningExp);
		expect(warnConfig.minConfidence).toBe(0.2);
	});

	it("calculates reinforcement boost correctly", () => {
		const manager = new ConfidenceDecayManager();
		const freshExp = makeExperience({
			confidence: 0.6,
			createdAt: Date.now(), // fresh -> current = 0.6
		});

		// Boost = (1 - 0.6) * 1.0 * 0.5 = 0.2 -> new confidence = 0.8
		const boosted = manager.calculateReinforcementBoost(freshExp, 1.0);
		expect(boosted).toBeCloseTo(0.8, 4);
	});

	it("identifies experiences needing reinforcement", () => {
		const manager = new ConfidenceDecayManager({
			decayStartDelay: 100,
			halfLife: 100,
			minConfidence: 0.1,
		});

		const freshExp = makeExperience({
			id: "fresh",
			confidence: 0.9,
			createdAt: Date.now(),
		});

		const decayedExp = makeExperience({
			type: ExperienceType.ACTION_RESULT,
			domain: "general",
			id: "decayed",
			confidence: 0.8,
			createdAt: Date.now() - 300, // 200ms decay = 2 half-lives -> 0.8 * 0.25 = 0.2
		});

		const ancientExp = makeExperience({
			type: ExperienceType.ACTION_RESULT,
			domain: "general",
			id: "ancient",
			confidence: 0.8,
			createdAt: Date.now() - 10000, // hits minConfidence = 0.1
		});

		const needing = manager.getExperiencesNeedingReinforcement(
			[freshExp, decayedExp, ancientExp],
			0.3,
		);

		expect(needing.map((e) => e.id)).toEqual(["decayed"]);
	});

	it("generates a confidence trend series over time", () => {
		const manager = new ConfidenceDecayManager();
		const exp = makeExperience({
			confidence: 0.8,
			createdAt: Date.now() - 1000 * 60 * 60 * 24 * 10,
		});

		const trend = manager.getConfidenceTrend(exp, 5);
		expect(trend).toHaveLength(5);
		expect(trend[0].confidence).toBe(0.8);
		expect(trend[0].timestamp).toBe(exp.createdAt);
	});
});
