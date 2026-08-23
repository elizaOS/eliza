import { describe, expect, it } from "vitest";
import { replaceIndexedNameTokens, replaceNameTokens } from "./name-tokens.ts";

describe("replaceNameTokens", () => {
	it("replaces {{name}} and {{agentName}}", () => {
		expect(replaceNameTokens("Hi {{name}}!", "Alice")).toBe("Hi Alice!");
		expect(replaceNameTokens("Hi {{agentName}}!", "Bob")).toBe("Hi Bob!");
	});

	it("tolerates inner whitespace", () => {
		expect(replaceNameTokens("{{ name }}", "X")).toBe("X");
		expect(replaceNameTokens("{{  agentName  }}", "Y")).toBe("Y");
	});

	it("inserts $-sequences literally", () => {
		expect(replaceNameTokens("{{name}}", "Cash$$")).toBe("Cash$$");
		expect(replaceNameTokens("{{name}}", "M$&M")).toBe("M$&M");
	});

	it("returns empty input unchanged", () => {
		expect(replaceNameTokens("", "X")).toBe("");
	});
});

describe("replaceIndexedNameTokens", () => {
	it("resolves positional name/user tokens", () => {
		expect(replaceIndexedNameTokens("{{name1}} {{user2}}", ["A", "B"])).toBe(
			"A B",
		);
	});

	it("leaves out-of-range slots untouched", () => {
		expect(replaceIndexedNameTokens("{{name3}}", ["A"])).toBe("{{name3}}");
	});

	it("tolerates whitespace", () => {
		expect(replaceIndexedNameTokens("{{ name1 }}", ["Z"])).toBe("Z");
	});
});
