/**
 * Deterministically tests the local `PII_SCRUB` adapter's prompt, parsing, and
 * fail-closed behavior without loading a native inference backend.
 */

import {
	type IAgentRuntime,
	ModelType,
	type PiiScrubParams,
} from "@elizaos/core";
import { describe, expect, test, vi } from "vitest";
import { createLocalInferenceModelHandlers } from "../provider.js";
import {
	buildLocalPiiScrubPrompt,
	createLocalPiiScrubHandler,
	parseLocalPiiScrubResult,
} from "./scrub-handler.js";

const params: PiiScrubParams = {
	text: "met jordan yesterday",
	candidateSpans: ["met jordan yesterday"],
	rulesetVersion: "2026.08",
	priority: "background",
};

describe("local PII scrub handler", () => {
	test("is registered on the local provider's dedicated PII model slot", () => {
		expect(createLocalInferenceModelHandlers()[ModelType.PII_SCRUB]).toEqual(
			expect.any(Function),
		);
	});

	test("inspects and rewrites a whole-text lowercase-name candidate locally", async () => {
		const generate = vi.fn(async () =>
			JSON.stringify({
				verdicts: [
					{
						span: "met jordan yesterday",
						kind: "pii",
						replacement: "met Person 1 yesterday",
					},
				],
			}),
		);
		const handler = createLocalPiiScrubHandler(generate);
		const result = await handler({} as IAgentRuntime, params);

		expect(result.modelId).toBe("eliza-local-inference");
		expect(result.verdicts).toEqual([
			{
				span: "met jordan yesterday",
				kind: "pii",
				replacement: "met Person 1 yesterday",
			},
		]);
		expect(generate).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ priority: "background" }),
		);
		expect(buildLocalPiiScrubPrompt(params)).toContain(
			'"candidateSpans":["met jordan yesterday"]',
		);
	});

	test("rejects malformed or incomplete model output", () => {
		expect(() => parseLocalPiiScrubResult("not json", params)).toThrow(
			/no JSON object/,
		);
		expect(() =>
			parseLocalPiiScrubResult(
				'{"verdicts":[{"span":"met jordan yesterday","kind":"pii"}]}',
				params,
			),
		).toThrow(/missing replacement/);
	});
});
