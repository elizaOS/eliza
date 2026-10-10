/**
 * Removing a stage direction tidies the spacing before punctuation. That must
 * not glue a token that starts with punctuation (".env", "!help", ".50") onto
 * the previous word.
 */

import { describe, expect, it } from "vitest";
import { stripAssistantStageDirections } from "../src/utils/assistant-text";

describe("stripAssistantStageDirections punctuation spacing", () => {
	it("keeps the space before a token that starts with punctuation", () => {
		expect(
			stripAssistantStageDirections("*nods* Add the key to your .env file."),
		).toBe("Add the key to your .env file.");
		expect(
			stripAssistantStageDirections("*smiles* Type !help to see the commands."),
		).toBe("Type !help to see the commands.");
		expect(
			stripAssistantStageDirections("*grins* It costs .50 per call."),
		).toBe("It costs .50 per call.");
	});

	it("still closes the gap a removed direction leaves before punctuation", () => {
		expect(stripAssistantStageDirections("Hello *waves* .")).toBe("Hello.");
		expect(stripAssistantStageDirections("Hello *waves*, friend.")).toBe(
			"Hello, friend.",
		);
		expect(stripAssistantStageDirections("*smiles* Really ?")).toBe("Really?");
	});
});
