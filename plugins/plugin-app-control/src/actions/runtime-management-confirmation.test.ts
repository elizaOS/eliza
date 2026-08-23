/** Adversarial coverage for fail-closed runtime mutation confirmation. */

import { describe, expect, it } from "vitest";
import { isUnambiguousRuntimeConfirmation } from "./runtime-management-confirmation.ts";

describe("runtime mutation confirmation", () => {
	it.each([
		"No, don't do it",
		"Yes, but do not proceed",
		"I did not confirm",
		"Never revoke it",
		"Confirm after I check",
		"Wait, yes",
		"Don't stop host",
		"Yes, confirm tomorrow",
	])("rejects negated or ambiguous text: %s", (text) => {
		expect(isUnambiguousRuntimeConfirmation(text, "revoke")).toBe(false);
	});

	it.each([
		"confirm the revocation",
		"yes, confirm revoke",
		"proceed with the revocation",
	])("accepts an unambiguous complete confirmation: %s", (text) => {
		expect(isUnambiguousRuntimeConfirmation(text, "revoke")).toBe(true);
	});

	it.each(["yes", "Yes, please", "confirm", "proceed", "go ahead", "do it"])(
		"rejects generic approval that is not bound to the requested operation: %s",
		(text) => {
			expect(isUnambiguousRuntimeConfirmation(text, "revoke")).toBe(false);
		},
	);

	it("binds subject-bearing confirmation to the requested operation", () => {
		expect(isUnambiguousRuntimeConfirmation("confirm pairing", "pair")).toBe(
			true,
		);
		expect(isUnambiguousRuntimeConfirmation("confirm pairing", "revoke")).toBe(
			false,
		);
	});
});
