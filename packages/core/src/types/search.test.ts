/**
 * Unit tests for the search-surface error contract: SearchCategoryRegistryError
 * carries the registry error code and category that getSearchCategory consumers
 * branch on when a lookup misses or resolves to a disabled category.
 */
import { describe, expect, it } from "vitest";
import { SearchCategoryRegistryError } from "./search.ts";

describe("SearchCategoryRegistryError", () => {
	it("constructs with SEARCH_CATEGORY_NOT_FOUND and preserves all fields", () => {
		const err = new SearchCategoryRegistryError(
			"SEARCH_CATEGORY_NOT_FOUND",
			"web",
			"No search category registered for category: web",
		);

		expect(err).toBeInstanceOf(SearchCategoryRegistryError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("SearchCategoryRegistryError");
		expect(err.code).toBe("SEARCH_CATEGORY_NOT_FOUND");
		expect(err.category).toBe("web");
		expect(err.message).toBe("No search category registered for category: web");
	});

	it("constructs with SEARCH_CATEGORY_DISABLED and preserves all fields", () => {
		const err = new SearchCategoryRegistryError(
			"SEARCH_CATEGORY_DISABLED",
			"linear_issues",
			"Search category disabled: linear_issues (turned off by operator)",
		);

		expect(err).toBeInstanceOf(SearchCategoryRegistryError);
		expect(err.name).toBe("SearchCategoryRegistryError");
		expect(err.code).toBe("SEARCH_CATEGORY_DISABLED");
		expect(err.category).toBe("linear_issues");
		expect(err.message).toBe(
			"Search category disabled: linear_issues (turned off by operator)",
		);
	});

	it("survives a throw/catch round trip with code and category intact", () => {
		const caught: unknown = (() => {
			try {
				throw new SearchCategoryRegistryError(
					"SEARCH_CATEGORY_DISABLED",
					"youtube",
					"Search category disabled: youtube",
				);
			} catch (e) {
				return e;
			}
		})();

		expect(caught).toBeInstanceOf(SearchCategoryRegistryError);
		const err = caught as SearchCategoryRegistryError;
		expect(err.code).toBe("SEARCH_CATEGORY_DISABLED");
		expect(err.category).toBe("youtube");
	});

	it("is distinguishable from a plain Error thrown through the same boundary", () => {
		const classify = (e: unknown): string => {
			if (e instanceof SearchCategoryRegistryError) {
				return e.code;
			}
			if (e instanceof Error) {
				return "plain";
			}
			return "unknown";
		};

		expect(classify(new Error("boom"))).toBe("plain");
		expect(
			classify(
				new SearchCategoryRegistryError(
					"SEARCH_CATEGORY_NOT_FOUND",
					"github",
					"No search category registered for category: github",
				),
			),
		).toBe("SEARCH_CATEGORY_NOT_FOUND");
		expect(classify(undefined)).toBe("unknown");
	});

	it("accepts an empty message without altering code or category", () => {
		const err = new SearchCategoryRegistryError(
			"SEARCH_CATEGORY_NOT_FOUND",
			"",
			"",
		);

		expect(err.message).toBe("");
		expect(err.code).toBe("SEARCH_CATEGORY_NOT_FOUND");
		expect(err.category).toBe("");
	});
});
