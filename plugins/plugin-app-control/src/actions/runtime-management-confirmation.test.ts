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
		"confirm revoke runtime=controller-one",
		"yes, confirm revoke runtime=controller-one",
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
			"confirm revoke runtime=controller-one",
		);
	});

	it("binds target confirmation to the exact claimed controller session", () => {
		const pairing = {
			op: "confirm_pairing" as const,
			sessionId: "11111111-1111-4111-8111-111111111111",
		};
		expect(runtimeManagementConfirmationText(pairing)).toBe(
			"confirm pairing session=11111111-1111-4111-8111-111111111111",
		);
		expect(
			isBoundRuntimeManagementConfirmation(
				"confirm pairing 22222222-2222-4222-8222-222222222222",
				pairing,
			),
		).toBe(false);
	});

	it("keeps effect-defining SSH fields in the human phrase", () => {
		const good = {
			op: "connect_ssh" as const,
			runtimeId: "prod",
			target: "admin@good.example",
			sshPort: 22,
			remoteApiPort: 2138,
			expectedFingerprint: "SHA256:GOOD",
			identityFile: "/Users/me/.ssh/good",
		};
		const evil = {
			...good,
			target: "root@evil.example",
			sshPort: 2222,
			expectedFingerprint: "SHA256:EVIL",
			identityFile: "/tmp/attacker-key",
		};
		const phrase = runtimeManagementConfirmationText(good);
		expect(phrase).toContain("target=admin@good.example");
		expect(phrase).toContain("fingerprint=SHA256:GOOD");
		expect(isBoundRuntimeManagementConfirmation(phrase, evil)).toBe(false);
	});

	it("does not normalize away punctuation that distinguishes targets or URLs", () => {
		const sshA = {
			op: "connect_ssh" as const,
			runtimeId: "prod",
			target: "admin@good.example:prod",
			sshPort: 22,
			remoteApiPort: 2138,
			expectedFingerprint: "SHA256:GOOD",
		};
		const sshB = { ...sshA, target: "admin@good.example-prod" };
		expect(isBoundRuntimeManagementConfirmation(runtimeManagementConfirmationText(sshA), sshB)).toBe(false);
		const directA = { op: "add_direct" as const, runtimeId: "prod", apiBase: "https://good.example/a-b" };
		const directB = { ...directA, apiBase: "https://good.example/a.b" };
		expect(isBoundRuntimeManagementConfirmation(runtimeManagementConfirmationText(directA), directB)).toBe(false);
	});

	it("distinguishes managed-network opt-in and rejects incomplete enrollment", () => {
		const managed = {
			op: "enroll_host" as const,
			platform: "linux" as const,
			managedNetwork: true,
		};
		const local = { ...managed, managedNetwork: false };
		expect(runtimeManagementConfirmationText(managed)).not.toBe(
			runtimeManagementConfirmationText(local),
		);
		expect(
			isBoundRuntimeManagementConfirmation(
				runtimeManagementConfirmationText(managed),
				local,
			),
		).toBe(false);
		expect(
			isBoundRuntimeManagementConfirmation("confirm enroll host", {
				op: "enroll_host",
				platform: "linux",
			}),
		).toBe(false);
	});
});
