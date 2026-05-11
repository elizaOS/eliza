/**
 * @fileoverview Calibration suite — hand-graded cases vs judge verdict.
 *
 * Target: ≥ 95% agreement on PASS/FAIL labels; ≤ 2% false-positive rate;
 * ≤ 10% NEEDS_REVIEW.
 *
 * The LLM-judge layer is DISABLED here on purpose. The phrase + trajectory
 * layers must be strong enough on their own to hit the targets. If the LLM
 * layer is wired up later (CEREBRAS_API_KEY present), the agreement only
 * improves — the targets are floor values, not ceilings.
 */

import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { gradeScenario } from "../src/judge/index.ts";
import type { CalibrationCase, PersonalityScenario, Verdict } from "../src/types.ts";

const CALIBRATION_DIR = path.resolve(__dirname, "calibration");

async function loadJsonl(filename: string): Promise<CalibrationCase[]> {
	const filePath = path.join(CALIBRATION_DIR, filename);
	const raw = await fs.readFile(filePath, "utf8");
	const lines = raw
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("//"));
	return lines.map((l) => JSON.parse(l) as CalibrationCase);
}

function toScenario(c: CalibrationCase): PersonalityScenario {
	return {
		id: c.scenario_id,
		bucket: c.bucket,
		personalityExpect: c.personalityExpect,
		trajectory: c.trajectory,
	};
}

interface Tally {
	total: number;
	agreed: number;
	disagreed: number;
	falsePositive: number;
	falseNegative: number;
	needsReview: number;
	mismatches: Array<{ id: string; expected: Verdict; actual: Verdict; reason: string }>;
}

async function grade(cases: CalibrationCase[]): Promise<Tally> {
	const tally: Tally = {
		total: cases.length,
		agreed: 0,
		disagreed: 0,
		falsePositive: 0,
		falseNegative: 0,
		needsReview: 0,
		mismatches: [],
	};
	for (const c of cases) {
		const verdict = await gradeScenario(toScenario(c), { enableLlm: false });
		if (verdict.verdict === "NEEDS_REVIEW") {
			tally.needsReview += 1;
			tally.mismatches.push({
				id: c.scenario_id,
				expected: c.ground_truth,
				actual: verdict.verdict,
				reason: verdict.reason,
			});
			continue;
		}
		if (verdict.verdict === c.ground_truth) {
			tally.agreed += 1;
		} else {
			tally.disagreed += 1;
			if (verdict.verdict === "PASS" && c.ground_truth === "FAIL") {
				tally.falsePositive += 1;
			}
			if (verdict.verdict === "FAIL" && c.ground_truth === "PASS") {
				tally.falseNegative += 1;
			}
			tally.mismatches.push({
				id: c.scenario_id,
				expected: c.ground_truth,
				actual: verdict.verdict,
				reason: verdict.reason,
			});
		}
	}
	return tally;
}

describe("personality judge — calibration suite", () => {
	it("agrees with ≥ 95% of hand-graded labels (no LLM)", async () => {
		const cases = await loadJsonl("hand-graded.jsonl");
		const adv = await loadJsonl("adversarial.jsonl");
		const all = [...cases, ...adv];
		expect(all.length).toBeGreaterThanOrEqual(30);
		const tally = await grade(all);
		const decided = tally.agreed + tally.disagreed;
		const agreement = decided === 0 ? 0 : tally.agreed / decided;
		const falsePositiveRate = tally.total === 0 ? 0 : tally.falsePositive / tally.total;
		const reviewRate = tally.total === 0 ? 0 : tally.needsReview / tally.total;
		// eslint-disable-next-line no-console
		console.log(
			`calibration: total=${tally.total} agreed=${tally.agreed} disagreed=${tally.disagreed} review=${tally.needsReview} fp=${tally.falsePositive} fn=${tally.falseNegative}`,
		);
		if (tally.mismatches.length > 0) {
			// eslint-disable-next-line no-console
			console.log("mismatches:", JSON.stringify(tally.mismatches, null, 2));
		}
		expect(falsePositiveRate).toBeLessThanOrEqual(0.02);
		expect(reviewRate).toBeLessThanOrEqual(0.1);
		expect(agreement).toBeGreaterThanOrEqual(0.95);
	}, 30000);
});
