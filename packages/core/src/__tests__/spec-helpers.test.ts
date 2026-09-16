/** Verifies optional spec lookups remain absent and required lookups fail for unknown capabilities. */
import { expect, it } from "vitest";
import {
	getActionSpec,
	getProviderSpec,
	requireActionSpec,
	requireProviderSpec,
} from "../generated/spec-helpers.ts";

it("distinguishes optional and required unknown action lookups", () => {
	expect(getActionSpec("UNKNOWN_ACTION_XYZ")).toBeUndefined();
	expect(() => requireActionSpec("UNKNOWN_ACTION_XYZ")).toThrow(
		"Action spec not found",
	);
});

it("distinguishes optional and required unknown provider lookups", () => {
	expect(getProviderSpec("UNKNOWN_PROVIDER_XYZ")).toBeUndefined();
	expect(() => requireProviderSpec("UNKNOWN_PROVIDER_XYZ")).toThrow(
		"Provider spec not found",
	);
});
