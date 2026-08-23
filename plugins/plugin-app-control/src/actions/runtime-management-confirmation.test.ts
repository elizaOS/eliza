/** Adversarial coverage for fail-closed runtime mutation confirmation. */

import { describe, expect, it } from "vitest";
import {
	isBoundRuntimeManagementConfirmation,
	runtimeManagementConfirmationText,
} from "./runtime-management-confirmation.ts";

const request = { op: "revoke" as const, targetId: "controller-one" };

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
		expect(isBoundRuntimeManagementConfirmation(text, request)).toBe(false);
	});

	it.each([
		"confirm revoke controller-one",
		"yes, confirm revoke controller-one",
	])("accepts an unambiguous complete confirmation: %s", (text) => {
		expect(isBoundRuntimeManagementConfirmation(text, request)).toBe(true);
	});

	it.each(["yes", "Yes, please", "confirm", "proceed", "go ahead", "do it"])(
		"rejects generic approval that is not bound to the requested operation: %s",
		(text) => {
			expect(isBoundRuntimeManagementConfirmation(text, request)).toBe(false);
		},
	);

	it("binds confirmation to both operation and target", () => {
		expect(
			isBoundRuntimeManagementConfirmation(
				"confirm revoke controller-two",
				request,
			),
		).toBe(false);
		expect(runtimeManagementConfirmationText(request)).toBe(
			"confirm revoke controller-one",
		);
	});
});
