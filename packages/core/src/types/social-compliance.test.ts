/**
 * Deterministic contract tests for the social integration compliance registry:
 * entry normalization, risk floors, review gating, blocked-operation planner
 * invisibility, and interoperation with `bindCapabilityRequest`. No network or
 * mocked collaborators — the real registry and contracts are exercised.
 */

import { describe, expect, it } from "vitest";
import {
	bindCapabilityRequest,
	createFirstPartySocialComplianceRegistry,
	FIRST_PARTY_SOCIAL_COMPLIANCE_ENTRIES,
	normalizeSocialComplianceEntry,
	PROVIDER_INTEGRATION_CONTRACT_VERSION,
	SOCIAL_COMPLIANCE_REGISTRY_VERSION,
	SocialComplianceRegistry,
} from "./index";

function baseEntry(overrides: Record<string, unknown> = {}) {
	return {
		registryVersion: SOCIAL_COMPLIANCE_REGISTRY_VERSION,
		providerId: "discord",
		useCase: "social.messaging",
		integrationStatus: "bot",
		appReviewState: "not_required",
		allowedOperations: [
			{ operation: "read_messages", kind: "read", riskLevel: "R0" },
			{ operation: "draft_message", kind: "draft", riskLevel: "R1" },
			{ operation: "post_message", kind: "write", riskLevel: "R3" },
		],
		retention: { maxRetentionDays: 90, deletionPropagationSupported: true },
		webhooks: { supported: true, deduplicationRequired: true },
		review: {
			owner: "elizaOS integrations",
			reviewedAt: "2026-08-20T00:00:00Z",
		},
		...overrides,
	};
}

describe("normalizeSocialComplianceEntry", () => {
	it("canonicalizes and freezes a valid entry", () => {
		const entry = normalizeSocialComplianceEntry(baseEntry());
		expect(entry.providerId).toBe("discord");
		expect(entry.allowedOperations).toHaveLength(3);
		expect(entry.review.reviewedAt).toBe("2026-08-20T00:00:00.000Z");
		expect(Object.isFrozen(entry)).toBe(true);
		expect(Object.isFrozen(entry.allowedOperations)).toBe(true);
	});

	it.each([
		["null", null],
		["array", []],
		["string", "entry"],
	])("rejects a non-object entry (%s)", (_label, value) => {
		expect(() => normalizeSocialComplianceEntry(value)).toThrow(
			/must be an object/,
		);
	});

	it("rejects unknown fields and wrong versions", () => {
		expect(() =>
			normalizeSocialComplianceEntry(baseEntry({ extra: true })),
		).toThrow(/unsupported fields/);
		expect(() =>
			normalizeSocialComplianceEntry(baseEntry({ registryVersion: 99 })),
		).toThrow(/unsupported version/);
	});

	it("enforces the R3 posting floor and the R1 draft floor", () => {
		expect(() =>
			normalizeSocialComplianceEntry(
				baseEntry({
					allowedOperations: [
						{ operation: "post_message", kind: "write", riskLevel: "R2" },
					],
				}),
			),
		).toThrow(/write risk floor/);
		expect(() =>
			normalizeSocialComplianceEntry(
				baseEntry({
					allowedOperations: [
						{ operation: "draft_message", kind: "draft", riskLevel: "R0" },
					],
				}),
			),
		).toThrow(/draft risk floor/);
	});

	it("allows contextual elevation above the floor, never below", () => {
		const entry = normalizeSocialComplianceEntry(
			baseEntry({
				allowedOperations: [
					{ operation: "read_messages", kind: "read", riskLevel: "R2" },
				],
			}),
		);
		expect(entry.allowedOperations[0]?.riskLevel).toBe("R2");
	});

	it("rejects operations on unsupported and handoff integrations", () => {
		for (const integrationStatus of ["unsupported", "handoff"]) {
			expect(() =>
				normalizeSocialComplianceEntry(baseEntry({ integrationStatus })),
			).toThrow(/cannot allow operations/);
		}
	});

	it("rejects write operations on experimental integrations", () => {
		expect(() =>
			normalizeSocialComplianceEntry(
				baseEntry({ integrationStatus: "experimental" }),
			),
		).toThrow(/cannot allow write operations/);
	});

	it("rejects duplicate operations", () => {
		expect(() =>
			normalizeSocialComplianceEntry(
				baseEntry({
					allowedOperations: [
						{ operation: "read_messages", kind: "read", riskLevel: "R0" },
						{ operation: "read_messages", kind: "read", riskLevel: "R1" },
					],
				}),
			),
		).toThrow(/operations must be unique/);
	});

	it("rejects invalid retention, webhook, and review shapes", () => {
		expect(() =>
			normalizeSocialComplianceEntry(
				baseEntry({
					retention: {
						maxRetentionDays: 0,
						deletionPropagationSupported: true,
					},
				}),
			),
		).toThrow(/positive integer or null/);
		expect(() =>
			normalizeSocialComplianceEntry(
				baseEntry({
					webhooks: { supported: true, deduplicationRequired: false },
				}),
			),
		).toThrow(/deduplication/);
		expect(() =>
			normalizeSocialComplianceEntry(
				baseEntry({
					review: { owner: " ", reviewedAt: "2026-08-20T00:00:00Z" },
				}),
			),
		).toThrow(/review.owner/);
		expect(() =>
			normalizeSocialComplianceEntry(
				baseEntry({
					review: { owner: "elizaOS integrations", reviewedAt: "yesterday" },
				}),
			),
		).toThrow(/ISO-8601/);
	});

	it("accepts uncapped retention as an explicit null", () => {
		const entry = normalizeSocialComplianceEntry(
			baseEntry({
				retention: {
					maxRetentionDays: null,
					deletionPropagationSupported: false,
				},
			}),
		);
		expect(entry.retention.maxRetentionDays).toBeNull();
	});
});

describe("SocialComplianceRegistry", () => {
	it("rejects duplicate provider/use-case registration", () => {
		const registry = new SocialComplianceRegistry();
		registry.register(baseEntry());
		expect(() => registry.register(baseEntry())).toThrow(/already registered/);
	});

	it("blocks unregistered providers, use cases, and operations", () => {
		const registry = new SocialComplianceRegistry();
		registry.register(baseEntry());
		expect(
			registry.resolveOperationVisibility(
				"mastodon",
				"social.messaging",
				"read_messages",
			),
		).toEqual({ visible: false, reason: "integration_unsupported" });
		expect(
			registry.resolveOperationVisibility(
				"discord",
				"social.publishing",
				"read_messages",
			),
		).toEqual({ visible: false, reason: "integration_unsupported" });
		expect(
			registry.resolveOperationVisibility(
				"discord",
				"social.messaging",
				"mass_follow",
			),
		).toEqual({ visible: false, reason: "operation_not_allowed" });
	});

	it("blocks handoff integrations with a handoff reason", () => {
		const registry = createFirstPartySocialComplianceRegistry();
		expect(
			registry.resolveOperationVisibility(
				"imessage",
				"social.messaging",
				"post_message",
			),
		).toEqual({ visible: false, reason: "handoff_required" });
	});

	it("blocks drafts and writes until platform app review clears", () => {
		const registry = createFirstPartySocialComplianceRegistry();
		expect(
			registry.resolveOperationVisibility(
				"instagram",
				"social.publishing",
				"publish_post",
			),
		).toEqual({ visible: false, reason: "app_review_incomplete" });
		expect(
			registry.resolveOperationVisibility(
				"instagram",
				"social.publishing",
				"draft_post",
			),
		).toEqual({ visible: false, reason: "app_review_incomplete" });
		expect(
			registry.resolveOperationVisibility(
				"instagram",
				"social.publishing",
				"read_media",
			),
		).toEqual({ visible: true, riskLevel: "R0" });
	});

	it("blocks in_review, rejected, and expired review states for writes", () => {
		for (const appReviewState of ["in_review", "rejected", "expired"]) {
			const registry = new SocialComplianceRegistry();
			registry.register(
				baseEntry({ integrationStatus: "business", appReviewState }),
			);
			expect(
				registry.resolveOperationVisibility(
					"discord",
					"social.messaging",
					"post_message",
				),
			).toEqual({ visible: false, reason: "app_review_incomplete" });
		}
	});

	it("surfaces approved writes at R3", () => {
		const registry = createFirstPartySocialComplianceRegistry();
		expect(
			registry.resolveOperationVisibility(
				"x",
				"social.publishing",
				"publish_post",
			),
		).toEqual({ visible: true, riskLevel: "R3" });
	});

	it("projects only visible operations as planner capabilities", () => {
		const registry = createFirstPartySocialComplianceRegistry();
		const instagram = registry.projectPlannerCapabilities("instagram");
		expect(instagram.map(({ capabilityId }) => capabilityId)).toEqual([
			"social.publishing.read_media",
		]);
		expect(registry.projectPlannerCapabilities("imessage")).toEqual([]);
		const discord = registry.projectPlannerCapabilities("discord");
		expect(discord).toHaveLength(3);
		expect(
			discord.find(
				({ capabilityId }) => capabilityId === "social.messaging.post_message",
			)?.riskLevel,
		).toBe("R3");
	});

	it("rejects blank lookup inputs instead of defaulting open", () => {
		const registry = createFirstPartySocialComplianceRegistry();
		expect(() =>
			registry.resolveOperationVisibility(
				" ",
				"social.messaging",
				"read_messages",
			),
		).toThrow(/providerId/);
		expect(() => registry.projectPlannerCapabilities("")).toThrow(/providerId/);
	});
});

describe("planner contract interoperation", () => {
	function accountFor(providerId: string) {
		const registry = createFirstPartySocialComplianceRegistry();
		return {
			contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
			accountId: "acct-1",
			providerId,
			mode: "cloud",
			status: "connected",
			displayName: null,
			capabilities: [...registry.projectPlannerCapabilities(providerId)],
			lastUsedAt: null,
		};
	}

	function requestFor(capabilityId: string, riskLevel: string) {
		return {
			contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
			requestId: "req-1",
			capabilityId,
			operation: "dispatch",
			riskLevel,
			accountId: "acct-1",
			inputDigest: "a".repeat(64),
		};
	}

	it("binds a projected posting capability at R3", () => {
		const bound = bindCapabilityRequest(
			requestFor("social.messaging.post_message", "R3"),
			accountFor("discord"),
			"2026-08-20T01:00:00Z",
		);
		expect(bound.account.capability.riskLevel).toBe("R3");
	});

	it("cannot bind a blocked posting capability because it is never projected", () => {
		expect(() =>
			bindCapabilityRequest(
				requestFor("social.publishing.publish_post", "R3"),
				accountFor("instagram"),
				"2026-08-20T01:00:00Z",
			),
		).toThrow(/unavailable for the selected account/);
	});

	it("cannot downgrade a projected posting capability below R3", () => {
		expect(() =>
			bindCapabilityRequest(
				requestFor("social.messaging.post_message", "R1"),
				accountFor("discord"),
				"2026-08-20T01:00:00Z",
			),
		).toThrow(/downgrade catalog risk/);
	});
});

describe("first-party baseline", () => {
	it("covers every first-party social provider exactly once per use case", () => {
		const keys = FIRST_PARTY_SOCIAL_COMPLIANCE_ENTRIES.map(
			({ providerId, useCase }) => `${providerId} ${useCase}`,
		);
		expect(new Set(keys).size).toBe(keys.length);
		expect(
			FIRST_PARTY_SOCIAL_COMPLIANCE_ENTRIES.map(
				({ providerId }) => providerId,
			).sort(),
		).toEqual([
			"discord",
			"imessage",
			"instagram",
			"matrix",
			"slack",
			"telegram",
			"whatsapp",
			"x",
		]);
	});

	it("keeps every baseline write at R3 with a named review owner and date", () => {
		for (const entry of FIRST_PARTY_SOCIAL_COMPLIANCE_ENTRIES) {
			expect(entry.review.owner.length).toBeGreaterThan(0);
			expect(Number.isFinite(Date.parse(entry.review.reviewedAt))).toBe(true);
			for (const operation of entry.allowedOperations) {
				if (operation.kind === "write") {
					expect(operation.riskLevel).toBe("R3");
				}
			}
		}
	});
});
