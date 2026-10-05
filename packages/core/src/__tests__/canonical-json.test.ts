import { describe, expect, it } from "vitest";
import {
	AGENT_BACKUP_CANONICAL_JSON,
	stableJsonString,
} from "../canonical-json";

describe("stable JSON absence", () => {
	it.each([undefined, Symbol("absent"), () => {}])(
		"preserves an absent root value",
		(value) => {
			expect(
				stableJsonString(value, AGENT_BACKUP_CANONICAL_JSON),
			).toBeUndefined();
		},
	);
	it("keeps canonical backup bytes and distinguishes null from absence", () => {
		expect(
			stableJsonString(
				{ b: undefined, c: [undefined, null], a: 1 },
				AGENT_BACKUP_CANONICAL_JSON,
			),
		).toBe('{"a":1,"c":[null,null]}');
		expect(stableJsonString(null, AGENT_BACKUP_CANONICAL_JSON)).toBe("null");
	});
});
