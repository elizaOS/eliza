import { describe, expect, it } from "vitest";

import { parseJsonObject } from "../json-output";

describe("parseJsonObject", () => {
	it("parses the first balanced JSON object when providers append garbage", () => {
		expect(
			parseJsonObject('{"plan":{"contexts":["tasks"]},"thought":"ok"}\u0000'),
		).toEqual({
			plan: { contexts: ["tasks"] },
			thought: "ok",
		});
	});

	it("does not treat partial JSON as valid", () => {
		expect(parseJsonObject('{"plan":{"contexts":["tasks"]}')).toBeNull();
	});
});
