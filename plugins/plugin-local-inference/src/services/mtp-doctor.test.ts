/**
 * MTP doctor coverage checks for the Gemma drafter rollout.
 *
 * The hardware probe may vary by host; this test pins the artifact-coverage
 * check that must fail until every Eliza-1 tier hosts a drafter GGUF.
 */

import { describe, expect, it } from "vitest";
import { runMtpDoctor } from "./mtp-doctor";

describe("runMtpDoctor", () => {
	it("fails the coverage check while Gemma drafter hosting is partial", async () => {
		const report = await runMtpDoctor();
		const coverage = report.checks.find(
			(check) => check.label === "Gemma MTP drafter coverage",
		);
		expect(coverage?.status).toBe("fail");
		expect(coverage?.detail).toContain("2/5");
		expect(report.ok).toBe(false);
	});
});
