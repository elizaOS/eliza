import { describe, expect, it } from "vitest";
import {
	ACTION_PARAMETER_UNBOUNDED,
	parseActionParams,
} from "../src/action-parameter-value.ts";
import { ElizaError } from "../src/errors.ts";

describe("parseActionParams action-name handling", () => {
	it("rejects duplicate action names that normalize to the same key", () => {
		let caught: unknown;
		try {
			parseActionParams({
				deploy: { target: "prod" },
				" DEPLOY ": { target: "staging" },
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ElizaError);
		expect((caught as ElizaError).code).toBe(ACTION_PARAMETER_UNBOUNDED);
	});

	it("skips empty action names instead of storing an empty key", () => {
		const result = parseActionParams({
			"   ": { target: "prod" },
			deploy: { target: "prod" },
		});
		expect(result.has("")).toBe(false);
		expect(result.get("DEPLOY")).toEqual({ target: "prod" });
	});

	it("still parses distinct actions normally", () => {
		const result = parseActionParams({
			deploy: { target: "prod" },
			rollback: { target: "prod" },
		});
		expect(result.get("DEPLOY")).toEqual({ target: "prod" });
		expect(result.get("ROLLBACK")).toEqual({ target: "prod" });
	});
});
