/** Verifies runtime setup aliases resolve to catalog-backed account authority IDs. */

import { describe, expect, it } from "vitest";
import {
	getDirectAccountProviderForFirstRunProvider,
	getFirstRunProviderFamily,
	getFirstRunProviderOption,
	normalizeFirstRunProviderId,
} from "./first-run-options.ts";

describe("OpenRouter and xAI runtime setup account authority", () => {
	it("keeps OpenRouter catalog-backed and idempotent", () => {
		expect(normalizeFirstRunProviderId("openrouter-api")).toBe("openrouter");
		expect(normalizeFirstRunProviderId("openrouter")).toBe("openrouter");
		expect(getFirstRunProviderOption("openrouter-api")).toMatchObject({
			id: "openrouter",
			family: "openrouter",
		});
		expect(getDirectAccountProviderForFirstRunProvider("openrouter-api")).toBe(
			"openrouter-api",
		);
	});

	it("normalizes xAI aliases idempotently to the catalog-backed Grok option", () => {
		for (const alias of ["xai", "xai-api", "grok"] as const) {
			const normalized = normalizeFirstRunProviderId(alias);
			expect(normalized).toBe("grok");
			expect(normalizeFirstRunProviderId(normalized)).toBe(normalized);
			expect(getFirstRunProviderOption(alias)).toMatchObject({
				id: "grok",
				family: "grok",
			});
			expect(getFirstRunProviderFamily(alias)).toBe("grok");
			expect(getDirectAccountProviderForFirstRunProvider(alias)).toBe(
				"xai-api",
			);
		}
	});
});
