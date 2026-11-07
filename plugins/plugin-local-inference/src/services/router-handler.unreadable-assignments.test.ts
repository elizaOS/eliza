/**
 * An unreadable assignments.json must not abort every text call. Under an
 * automatic policy the router treats local as unavailable and keeps the other
 * providers; under a forced-local policy the read error is the call's error.
 */
import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./assignments", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./assignments")>();
	return {
		...actual,
		readEffectiveAssignments: vi.fn(async () => {
			throw new actual.AssignmentsUnreadableError(
				"/state/local-inference/assignments.json",
				new SyntaxError("Unexpected end of JSON input"),
			);
		}),
	};
});

vi.mock("./engine", () => ({
	localInferenceEngine: { hasLoadedModel: vi.fn(() => false) },
}));

const { filterUnavailableLocalInference } = await import("./router-handler");

const handler = vi.fn();
const candidates = [
	{
		modelType: "TEXT_SMALL",
		provider: "eliza-local-inference",
		priority: 0,
		handler,
	},
	{ modelType: "TEXT_SMALL", provider: "elizaOSCloud", priority: 0, handler },
];

describe("filterUnavailableLocalInference with unreadable assignments", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops local, keeps cloud, and logs the error under an automatic policy", async () => {
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		const result = await filterUnavailableLocalInference(
			"TEXT_SMALL",
			"prefer-local",
			null,
			candidates,
		);

		expect(result.map((candidate) => candidate.provider)).toEqual([
			"elizaOSCloud",
		]);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it("rethrows when the policy forces local inference", async () => {
		vi.spyOn(logger, "error").mockImplementation(() => {});

		await expect(
			filterUnavailableLocalInference(
				"TEXT_SMALL",
				"local-only",
				null,
				candidates,
			),
		).rejects.toThrow(/assignments\.json/);
		await expect(
			filterUnavailableLocalInference(
				"TEXT_SMALL",
				"manual",
				"eliza-local-inference",
				candidates,
			),
		).rejects.toThrow(/assignments\.json/);
	});
});
