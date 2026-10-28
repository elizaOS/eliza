import { expect, test } from "vitest";
import { replaceNameTokens } from "../src/name-tokens";

test("name substitution does not parse tokens in the inserted name", () => {
	const name = "Agent {{agentName}} $&";
	expect(replaceNameTokens("Hello {{name}} and {{agentName}}.", name)).toBe(
		`Hello ${name} and ${name}.`,
	);
});
