/**
 * Covers the runtime surface of the trust capability's security type
 * definitions: the `SecurityEventType` enum whose snake_case members are the
 * persisted wire vocabulary for `SecurityEvent.type`. SecurityModule resolves
 * every member through an exhaustive `Record<SecurityEventType,
 * TrustEvidenceType>` mapping, while CredentialProtector and the service
 * wrappers emit specific members, so the load-bearing contracts are wire-value
 * stability, value uniqueness, string-enum enumeration semantics (no
 * reverse-mapping entries), and serialization round-trips. Pure deterministic
 * harness against the real module; no mocks.
 */
import { describe, expect, it } from "vitest";
import { SecurityEventType } from "./security.ts";

const ALL_VALUES = Object.values(SecurityEventType);
const MEMBER_NAMES = [
	"PROMPT_INJECTION_ATTEMPT",
	"SOCIAL_ENGINEERING_ATTEMPT",
	"PRIVILEGE_ESCALATION_ATTEMPT",
	"ANOMALOUS_REQUEST",
	"TRUST_MANIPULATION",
	"IDENTITY_SPOOFING",
	"MULTI_ACCOUNT_ABUSE",
	"CREDENTIAL_THEFT_ATTEMPT",
	"PHISHING_ATTEMPT",
	"IMPERSONATION_ATTEMPT",
	"COORDINATED_ATTACK",
	"MALICIOUS_LINK_CAMPAIGN",
] as const;

describe("SecurityEventType wire vocabulary", () => {
	it("maps every member to its canonical persisted snake_case string", () => {
		expect(SecurityEventType.PROMPT_INJECTION_ATTEMPT).toBe(
			"prompt_injection_attempt",
		);
		expect(SecurityEventType.SOCIAL_ENGINEERING_ATTEMPT).toBe(
			"social_engineering_attempt",
		);
		expect(SecurityEventType.PRIVILEGE_ESCALATION_ATTEMPT).toBe(
			"privilege_escalation_attempt",
		);
		expect(SecurityEventType.ANOMALOUS_REQUEST).toBe("anomalous_request");
		expect(SecurityEventType.TRUST_MANIPULATION).toBe("trust_manipulation");
		expect(SecurityEventType.IDENTITY_SPOOFING).toBe("identity_spoofing");
		expect(SecurityEventType.MULTI_ACCOUNT_ABUSE).toBe("multi_account_abuse");
		expect(SecurityEventType.CREDENTIAL_THEFT_ATTEMPT).toBe(
			"credential_theft_attempt",
		);
		expect(SecurityEventType.PHISHING_ATTEMPT).toBe("phishing_attempt");
		expect(SecurityEventType.IMPERSONATION_ATTEMPT).toBe(
			"impersonation_attempt",
		);
		expect(SecurityEventType.COORDINATED_ATTACK).toBe("coordinated_attack");
		expect(SecurityEventType.MALICIOUS_LINK_CAMPAIGN).toBe(
			"malicious_link_campaign",
		);
	});

	it("exposes exactly the twelve declared members", () => {
		expect(ALL_VALUES).toHaveLength(MEMBER_NAMES.length);
	});

	it("keeps every event type value unique so exhaustive lookups cannot collapse", () => {
		expect(new Set(ALL_VALUES).size).toBe(ALL_VALUES.length);
	});
});

describe("SecurityEventType enumeration semantics", () => {
	const enumAsRecord = SecurityEventType as unknown as Record<string, string>;

	it("enumerates each member name exactly once with no reverse-mapping keys", () => {
		expect(Object.keys(enumAsRecord).sort()).toEqual([...MEMBER_NAMES].sort());
	});

	it("does not resolve a value string back to its key through bracket access", () => {
		expect(enumAsRecord["prompt_injection_attempt"]).toBeUndefined();
		expect(enumAsRecord["coordinated_attack"]).toBeUndefined();
	});

	it("resolves every member by name through bracket access", () => {
		for (const name of MEMBER_NAMES) {
			expect(typeof enumAsRecord[name]).toBe("string");
			expect(ALL_VALUES).toContain(enumAsRecord[name]);
		}
	});
});

describe("SecurityEventType serialization boundary", () => {
	const membership = new Map<string, SecurityEventType>(
		ALL_VALUES.map((value) => [value, value]),
	);

	it("round-trips an emitted SecurityEvent through JSON without losing its type", () => {
		const emitted = {
			type: SecurityEventType.CREDENTIAL_THEFT_ATTEMPT,
			entityId: "11111111-2222-4333-8444-555555555555",
			severity: "critical",
			details: { source: "clipboard" },
		};
		const stored = JSON.parse(JSON.stringify(emitted)) as typeof emitted;
		expect(membership.get(stored.type)).toBe(
			SecurityEventType.CREDENTIAL_THEFT_ATTEMPT,
		);
	});

	it("fails membership resolution for a string that is not a declared event type", () => {
		expect(membership.has("totally_unknown_event")).toBe(false);
		expect(membership.has("prompt_injection")).toBe(false);
	});
});
