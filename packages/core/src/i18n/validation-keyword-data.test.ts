/**
 * Unit tests for generated validation keyword datasets and supported locales.
 */

import { describe, expect, it } from "vitest";
import {
	VALIDATION_KEYWORD_DOCS,
	VALIDATION_KEYWORD_LOCALES,
} from "./generated/validation-keyword-data.js";

describe("validation-keyword-data", () => {
	it("exports expected standard validation keyword locales", () => {
		expect(VALIDATION_KEYWORD_LOCALES).toEqual([
			"es",
			"ko",
			"pt",
			"tl",
			"vi",
			"zh-CN",
		]);
	});

	it("contains populated keyword docs with base and locale definitions", () => {
		expect(VALIDATION_KEYWORD_DOCS).toBeDefined();
		expect(typeof VALIDATION_KEYWORD_DOCS).toBe("object");

		const rootKeys = Object.keys(VALIDATION_KEYWORD_DOCS);
		expect(rootKeys).toContain("action");

		const actionDoc = VALIDATION_KEYWORD_DOCS.action as Record<string, unknown>;
		expect(actionDoc).toBeDefined();
		expect(Object.keys(actionDoc).length).toBeGreaterThan(0);
	});
});
