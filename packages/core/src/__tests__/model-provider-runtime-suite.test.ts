/**
 * Unit tests for model-provider test runtime harness.
 * Validates deterministic model fixture registration, execution, and fixture diagnostics.
 */
import { describe, expect, it } from "vitest";
import { createTestRuntimeWithModelProvider } from "../testing/model-provider-runtime.ts";
import { ModelType } from "../types/model.ts";

describe("model-provider-runtime", () => {
	it("initializes test runtime with deterministic model provider and fixtures", async () => {
		const testFixture = {
			name: "sample-query-fixture",
			match: {
				modelType: ModelType.TEXT_LARGE,
				prompt: "test-query",
			},
			response: "deterministic-answer",
		};

		const harness = await createTestRuntimeWithModelProvider({
			characterName: "TestFixtureAgent",
			fixtures: [testFixture],
		});

		try {
			expect(harness.runtime).toBeDefined();
			expect(harness.modelProvider).toBeDefined();
			expect(harness.fixtures).toBeDefined();
			expect(typeof harness.assertFixturesConsumed).toBe("function");
			expect(typeof harness.getFixtureDiagnostics).toBe("function");

			const diagnostics = harness.getFixtureDiagnostics();
			expect(diagnostics).toBeDefined();
			expect(diagnostics.fixtures.length).toBeGreaterThanOrEqual(1);
			expect(diagnostics.fixtures[0].name).toBe("sample-query-fixture");
		} finally {
			await harness.cleanup();
		}
	});
});
