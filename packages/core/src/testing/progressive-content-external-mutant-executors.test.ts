/** Exercises every core-owned external mutant through its production oracle. */

import { describe, expect, it } from "vitest";
import { createCoreProgressiveContentExternalMutantExecutors } from "./progressive-content-external-mutant-executors.ts";
import { PROGRESSIVE_CONTENT_REQUIRED_MUTANTS } from "./progressive-content-mutants.ts";

describe("core progressive-content external mutant executors", () => {
	it("kills every core-owned external mutant with its registered vector", async () => {
		const executors = createCoreProgressiveContentExternalMutantExecutors();
		for (const mutant of PROGRESSIVE_CONTENT_REQUIRED_MUTANTS) {
			if (!(mutant.id in executors)) continue;
			await expect(
				Promise.resolve().then(() =>
					executors[mutant.id as keyof typeof executors].execute(),
				),
			).rejects.toMatchObject({ vector: mutant.killingVector });
		}
		expect(Object.keys(executors)).toHaveLength(11);
	});
});
