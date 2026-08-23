/** Proves every registered mutant executes and is rejected by its named vector. */

import { describe, expect, it } from "vitest";
import {
	progressiveConformanceAdapter,
	progressiveConformanceFixture,
} from "./progressive-content-conformance.fixture";
import {
	PROGRESSIVE_CONTENT_MUTANTS,
	applyProgressiveContentMutant,
	runProgressiveContentMutants,
} from "./progressive-content-mutants";

describe("progressive content mutant registry", () => {
	it("executes concrete defects and emits a 100 percent kill report", async () => {
		const { object } = progressiveConformanceFixture();
		const report = await runProgressiveContentMutants({
			object,
			createAdapter: progressiveConformanceAdapter,
		});
		expect(report).toMatchObject({
			required: PROGRESSIVE_CONTENT_MUTANTS.length,
			executed: PROGRESSIVE_CONTENT_MUTANTS.length,
			killed: PROGRESSIVE_CONTENT_MUTANTS.length,
			killRate: 1,
			status: "passed",
		});
		for (const result of report.results) {
			expect(result.failureVectors).toContain(result.killingVector);
		}
	});

	it("mutates measured work instead of accepting a self-report", async () => {
		const { object } = progressiveConformanceFixture();
		const base = progressiveConformanceAdapter();
		const mutant = applyProgressiveContentMutant(
			base,
			"whole-source-materialization",
			object,
		);
		const request = {
			objectId: object.id,
			authorizationScope: object.authorizationScope,
			offset: 0,
			limit: 64 * 1024,
		};
		expect((await base.read(request)).sourceWork.parentScans).toBe(0);
		expect((await mutant.read(request)).sourceWork).toMatchObject({
			bytesRead: object.byteLength,
			parentScans: 1,
		});
	});
});
