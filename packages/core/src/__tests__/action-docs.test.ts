import { describe, expect, it } from "vitest";
import {
	withCanonicalActionDocs,
	withCanonicalEvaluatorDocs,
	withCanonicalProviderDocs,
} from "../action-docs";
import type { Action, Evaluator, Provider } from "../types";

const handler = async () => ({ success: true });
const validate = async () => true;

describe("canonical component docs", () => {
	it("normalizes compressedDescription alias onto action docs", () => {
		const action = withCanonicalActionDocs({
			name: "PLUGIN_ALIAS",
			description: "Long plugin action description.",
			compressedDescription: "plugin alias desc.",
			handler,
			validate,
		} as Action);

		expect(action.descriptionCompressed).toBe("plugin alias desc.");
		expect(action.compressedDescription).toBe("plugin alias desc.");
	});

	it("fills provider compressed descriptions from canonical specs", () => {
		const provider = withCanonicalProviderDocs({
			name: "TIME",
			description: "Long provider description that should not render.",
			get: async () => ({}),
		} as Provider);

		expect(provider.descriptionCompressed).toBe("Current UTC date/time.");
	});

	it("fills evaluator compressed descriptions", () => {
		const evaluator = withCanonicalEvaluatorDocs({
			name: "LOCAL_EVALUATOR",
			description:
				"This evaluator is used to summarize conversation history while preserving important information.",
			examples: [],
			handler,
			validate,
		} as Evaluator);

		expect(evaluator.descriptionCompressed).toBe(
			"summarize convo history while preserving important info.",
		);
	});
});
