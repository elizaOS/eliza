import { describe, expect, it } from "vitest";
import type { ActionResult } from "../types/components.ts";
import { getActionResultActionName } from "./action-results.ts";
import { flattenTextValues } from "./text-normalize.ts";

describe("action result diagnostic text", () => {
	it("preserves error messages and enumerable context together", () => {
		const error = Object.assign(new TypeError("bad value"), {
			code: "BAD_VALUE",
			detail: "original input",
		});
		expect(flattenTextValues({ error })).toEqual([
			"error: TypeError: bad value, code: BAD_VALUE, detail: original input",
		]);
		Object.assign(error, { self: error });
		expect(flattenTextValues(error)).toEqual([
			"TypeError: bad value",
			"code: BAD_VALUE",
			"detail: original input",
		]);
		expect(flattenTextValues(new Error(""))).toEqual(["Error"]);
	});
	it("prefers action names over operation aliases and ignores malformed carriers", () => {
		const result = {
			success: true,
			actionName: "BROWSER",
			data: { action: "navigate" },
		};
		expect(getActionResultActionName(result)).toBe("BROWSER");
		expect(
			getActionResultActionName({
				...result,
				data: { actionName: "CANONICAL", action: "navigate" },
			}),
		).toBe("CANONICAL");
		expect(
			getActionResultActionName({
				success: true,
				data: { action: "SEARCH_WEB" },
			}),
		).toBe("SEARCH_WEB");
		expect(
			getActionResultActionName({
				success: true,
				data: { actionName: 42, action: " " },
			} as unknown as ActionResult),
		).toBe("Unknown Action");
	});
});
