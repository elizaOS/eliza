/**
 * Exercises real runtime model dispatch with PGlite and a strict fixture provider.
 * A registered but never dispatched fixture must not count as a passing test.
 */

import { createTestRuntimeWithModelProvider } from "@elizaos/testing/model-provider-runtime";
import { describe, expect, it } from "vitest";
import { ModelType } from "../types/model.ts";

describe("model-provider-runtime", () => {
	it("dispatches through the runtime and consumes the exact expected response", async () => {
		const testFixture = {
			name: "sample-query-fixture",
			match: {
				modelType: ModelType.TEXT_LARGE,
				prompt: "test-query",
			},
			response: "deterministic-answer",
			times: 1,
		};

		const harness = await createTestRuntimeWithModelProvider({
			characterName: "TestFixtureAgent",
			fixtures: [testFixture],
		});

		try {
			expect(() => harness.assertFixturesConsumed()).toThrow();
			await expect(
				harness.runtime.useModel(ModelType.TEXT_LARGE, {
					prompt: "test-query",
				}),
			).resolves.toBe("deterministic-answer");
			harness.assertFixturesConsumed();
		} finally {
			await harness.cleanup();
		}
	});
});
