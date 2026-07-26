/**
 * Verifies browser and edge consumers receive the real family-gated resolver
 * through the public core entrypoints.
 */

import { describe, expect, it } from "vitest";
import * as browserCore from "../index.browser";
import * as edgeCore from "../index.edge";
import {
	CANONICAL_MODEL_ENV_KEYS,
	readCanonicalModel,
} from "../utils/canonical-model";

describe.each([
	["browser", browserCore],
	["edge", edgeCore],
] as const)("@elizaos/core %s entrypoint", (_name, entrypoint) => {
	it("exports the canonical model-pair contract", () => {
		expect(entrypoint.CANONICAL_MODEL_ENV_KEYS).toBe(CANONICAL_MODEL_ENV_KEYS);
		expect(entrypoint.readCanonicalModel).toBe(readCanonicalModel);
		expect(entrypoint.canonicalModelIsQualified).toBeTypeOf("function");
	});

	it("retains family gating through the public entrypoint", () => {
		const options = {
			env: { ELIZA_MODEL_LARGE: "anthropic/claude-opus" },
		};
		expect(
			entrypoint.readCanonicalModel(null, "large", "anthropic", options),
		).toBe("claude-opus");
		expect(
			entrypoint.readCanonicalModel(null, "large", "openai", options),
		).toBeUndefined();
	});
});
