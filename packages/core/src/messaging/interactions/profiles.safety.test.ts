/**
 * Deterministic contract coverage for the security boundaries of connector
 * interaction capability profiles: the signed-hosted URL safety rules (HTTPS
 * only, no embedded credentials, no fragment, parseable) and the secret-flow
 * isolation rules (secret blocks travel only via sensitive-request, ordinary
 * blocks can never claim it, and every declared mode must have a non-secret
 * fallback). These boundaries gate what `negotiateInteractionDelivery` — the
 * delivery decision used by the durable interaction session authority — may
 * send users to; a regression would silently route interaction sessions to
 * insecure or credential-bearing URLs. Real templates and real parsers only;
 * no mocks.
 */

import { describe, expect, it } from "vitest";
import type {
	ChoiceInteraction,
	SecretInteraction,
} from "../../types/interactions";
import {
	BUTTON_INTERACTION_PROFILE,
	RICH_INTERACTION_PROFILE,
} from "./profile-catalog";
import {
	createConnectorInteractionCapabilityProfile,
	negotiateInteractionDelivery,
	normalizeConnectorInteractionCapabilityProfile,
} from "./profiles";

const choice: ChoiceInteraction = {
	kind: "choice",
	id: "approve-1",
	scope: "approval",
	options: [
		{ value: "approve", label: "Approve" },
		{ value: "deny", label: "Deny" },
	],
};

const secret: SecretInteraction = {
	kind: "secret",
	id: "pin-1",
	secretKind: "secret",
	reason: "Confirm your PIN",
};

function profile(template = BUTTON_INTERACTION_PROFILE) {
	return createConnectorInteractionCapabilityProfile({
		template,
		source: "connector",
		accountId: "account-a",
		targetKind: "room",
		targetId: "room-a",
	});
}

/** Profile whose choice block can only be delivered via signed-hosted. */
function signedHostedOnlyChoice() {
	const value = structuredClone(profile(RICH_INTERACTION_PROFILE));
	value.blocks.choice.modes = ["signed-hosted"];
	return value;
}

function unavailableError() {
	return expect.objectContaining({
		code: "INTERACTION_DELIVERY_UNAVAILABLE",
		context: expect.objectContaining({
			kind: "choice",
		}),
	});
}

/** Every validation guard shares one typed error code; pin it on each so a
 * regression to a plain Error with matching prose cannot pass. */
function invalidProfileError(message?: RegExp) {
	return expect.objectContaining({
		code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
		...(message ? { message: expect.stringMatching(message) } : {}),
	});
}

describe("signed-hosted URL safety contract", () => {
	it("refuses plain-HTTP hosted URLs even after host signature verification", () => {
		expect(() =>
			negotiateInteractionDelivery(choice, signedHostedOnlyChoice(), {
				signedHostedUrl: "http://example.test/form/a",
				signedHostedUrlVerified: true,
			}),
		).toThrowError(
			expect.objectContaining({
				code: "INTERACTION_DELIVERY_UNAVAILABLE",
				context: expect.objectContaining({
					limitations: expect.arrayContaining(["signed hosted URL unsafe"]),
				}),
			}),
		);
	});

	it("refuses hosted URLs carrying embedded credentials", () => {
		// Username-only and password-only forms, so each check arm is pinned
		// independently.
		expect(() =>
			negotiateInteractionDelivery(choice, signedHostedOnlyChoice(), {
				signedHostedUrl: "https://user@example.test/form/a",
				signedHostedUrlVerified: true,
			}),
		).toThrowError(unavailableError());
		expect(() =>
			negotiateInteractionDelivery(choice, signedHostedOnlyChoice(), {
				signedHostedUrl: "https://:pass@example.test/form/a",
				signedHostedUrlVerified: true,
			}),
		).toThrowError(unavailableError());
		expect(() =>
			negotiateInteractionDelivery(choice, signedHostedOnlyChoice(), {
				signedHostedUrl: "https://user:secret@example.test/form/a",
				signedHostedUrlVerified: true,
			}),
		).toThrowError(unavailableError());
	});

	it("refuses hosted URLs with a fragment component", () => {
		expect(() =>
			negotiateInteractionDelivery(choice, signedHostedOnlyChoice(), {
				signedHostedUrl: "https://example.test/form/a#token",
				signedHostedUrlVerified: true,
			}),
		).toThrowError(unavailableError());
	});

	it("refuses unparseable hosted URLs as explicit negotiation failures", () => {
		expect(() =>
			negotiateInteractionDelivery(choice, signedHostedOnlyChoice(), {
				signedHostedUrl: "not a url",
				signedHostedUrlVerified: true,
			}),
		).toThrowError(unavailableError());
	});

	it("accepts a verified HTTPS hosted URL with a query string", () => {
		expect(
			negotiateInteractionDelivery(choice, signedHostedOnlyChoice(), {
				signedHostedUrl: "https://example.test/form/a?session=1",
				signedHostedUrlVerified: true,
			}),
		).toMatchObject({ mode: "signed-hosted", limitations: [] });
	});

	it("surfaces an unsafe hosted URL as a recorded limitation when a conversational fallback exists", () => {
		// Native fails on the label-byte limit, then the unsafe hosted URL must
		// be reported (not silently skipped) on the way to the fallback mode.
		// RICH template orders choice modes native → signed-hosted →
		// conversational; disabling lists makes the button label limit bind.
		const value = structuredClone(profile(RICH_INTERACTION_PROFILE));
		value.limits.buttons.maxLabelBytes = 4;
		value.limits.lists = {
			supported: false,
			maxItems: 0,
			maxLabelBytes: 0,
			maxDescriptionBytes: 0,
		};
		const result = negotiateInteractionDelivery(
			{ ...choice, options: [{ value: "approve", label: "Approve" }] },
			value,
			{
				signedHostedUrl: "http://example.test/form/a",
				signedHostedUrlVerified: true,
			},
		);
		expect(result.mode).toBe("conversational");
		expect(result.reason).toBe("native-limit");
		expect(result.limitations).toEqual(
			expect.arrayContaining([
				"option label bytes",
				"signed hosted URL unsafe",
			]),
		);
	});
});

describe("secret-flow isolation contract", () => {
	it("routes secret blocks to sensitive-request regardless of connector capability", () => {
		expect(negotiateInteractionDelivery(secret, profile())).toEqual({
			mode: "sensitive-request",
			reason: "sensitive",
			limitations: [],
		});
	});

	it("rejects profiles whose secret block offers any non-sensitive mode", () => {
		const invalid = structuredClone(profile());
		invalid.blocks.secret.modes = ["sensitive-request", "conversational"];
		expect(() =>
			normalizeConnectorInteractionCapabilityProfile(invalid),
		).toThrowError(
			invalidProfileError(
				/Secret interactions must use only the sensitive-request flow/,
			),
		);
	});

	it("rejects profiles where an ordinary block claims sensitive-request", () => {
		const invalid = structuredClone(profile());
		invalid.blocks.choice.modes = ["native", "sensitive-request"];
		expect(() =>
			normalizeConnectorInteractionCapabilityProfile(invalid),
		).toThrowError(
			// The message distinguishes this guard from the unknown-mode guard,
			// which shares the typed error code.
			invalidProfileError(
				/Ordinary interaction blocks cannot use the sensitive-request mode/,
			),
		);
	});

	it("rejects nonSecretFallbacks that offer the sensitive-request flow", () => {
		// Typed as non-secret modes; an untrusted connector payload arrives as
		// parsed JSON, so the runtime guard is probed via a deliberate cast.
		const invalid = structuredClone(profile());
		invalid.nonSecretFallbacks = [
			"native",
			"conversational",
			"signed-hosted",
			"sensitive-request" as never,
		];
		expect(() =>
			normalizeConnectorInteractionCapabilityProfile(invalid),
		).toThrowError(invalidProfileError(/not a non-secret fallback/));
	});

	it("rejects profiles whose sensitiveFallback is not the sensitive-request flow", () => {
		const invalid = structuredClone(profile());
		invalid.sensitiveFallback = "conversational" as never;
		expect(() =>
			normalizeConnectorInteractionCapabilityProfile(invalid),
		).toThrowError(invalidProfileError(/must use the sensitive-request flow/));
	});

	it("rejects profiles whose block modes lack a declared non-secret fallback", () => {
		const invalid = structuredClone(profile());
		invalid.blocks.choice.modes = ["conversational", "signed-hosted"];
		invalid.nonSecretFallbacks = ["conversational"];
		expect(() =>
			normalizeConnectorInteractionCapabilityProfile(invalid),
		).toThrowError(
			invalidProfileError(
				/choice declares a mode missing from non-secret fallbacks/,
			),
		);
	});

	it("rejects unknown and repeated delivery modes", () => {
		const unknown = structuredClone(profile());
		// The mode list is typed; an untrusted connector payload arrives as
		// parsed JSON, so probe the runtime guard through a deliberate cast.
		unknown.blocks.choice.modes = ["telepathy" as never];
		expect(() =>
			normalizeConnectorInteractionCapabilityProfile(unknown),
		).toThrowError(invalidProfileError(/unknown choice mode/));

		const repeated = structuredClone(profile());
		repeated.blocks.choice.modes = ["native", "native"];
		expect(() =>
			normalizeConnectorInteractionCapabilityProfile(repeated),
		).toThrowError(invalidProfileError(/repeats a choice mode/));
	});
});
