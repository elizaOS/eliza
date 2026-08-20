/**
 * Social integration capability and compliance registry. Each entry records how
 * one social provider use case is integrated (official API, business API, bot
 * API, experimental, human handoff, or unsupported), its platform app-review
 * state, the reads/drafts/writes it is allowed to perform, retention, deletion,
 * and webhook posture, and the accountable review owner and date.
 *
 * The registry is the deterministic policy source for planner visibility:
 * blocked operations are never projected, so they cannot appear in the
 * `ConnectedAccountCapability` set that `bindCapabilityRequest` authorizes
 * against. Write operations carry a hard R3 risk floor and drafts an R1 floor;
 * entries cannot lower either. Scraping, self-botting, and mass-engagement use
 * cases must not be registered — there is no status that permits them.
 */

import { ElizaError } from "../errors";
import {
	CAPABILITY_RISK_LEVELS,
	type CapabilityRiskLevel,
	type ConnectedAccountCapability,
} from "./provider-integrations";

export const SOCIAL_COMPLIANCE_REGISTRY_VERSION = 1 as const;

export const SOCIAL_INTEGRATION_STATUSES = [
	"official",
	"business",
	"bot",
	"experimental",
	"handoff",
	"unsupported",
] as const;
export type SocialIntegrationStatus =
	(typeof SOCIAL_INTEGRATION_STATUSES)[number];

export const SOCIAL_APP_REVIEW_STATES = [
	"not_required",
	"not_submitted",
	"in_review",
	"approved",
	"rejected",
	"expired",
] as const;
export type SocialAppReviewState = (typeof SOCIAL_APP_REVIEW_STATES)[number];

export const SOCIAL_OPERATION_KINDS = ["read", "draft", "write"] as const;
export type SocialOperationKind = (typeof SOCIAL_OPERATION_KINDS)[number];

export const SOCIAL_BLOCKED_REASONS = [
	"integration_unsupported",
	"handoff_required",
	"experimental_writes_disabled",
	"app_review_incomplete",
	"operation_not_allowed",
] as const;
export type SocialBlockedReason = (typeof SOCIAL_BLOCKED_REASONS)[number];

/** One permitted operation with its enforced minimum-risk classification. */
export interface SocialAllowedOperation {
	operation: string;
	kind: SocialOperationKind;
	riskLevel: CapabilityRiskLevel;
}

export interface SocialRetentionPolicy {
	/** Maximum days provider content may be retained; null means no cap applies. */
	maxRetentionDays: number | null;
	/** Whether upstream deletion events must be honored by purging local copies. */
	deletionPropagationSupported: boolean;
}

export interface SocialWebhookPolicy {
	supported: boolean;
	/** Deduplication is mandatory wherever webhook delivery is supported. */
	deduplicationRequired: boolean;
}

export interface SocialComplianceReview {
	owner: string;
	reviewedAt: string;
}

export interface SocialComplianceEntry {
	registryVersion: typeof SOCIAL_COMPLIANCE_REGISTRY_VERSION;
	providerId: string;
	useCase: string;
	integrationStatus: SocialIntegrationStatus;
	appReviewState: SocialAppReviewState;
	allowedOperations: readonly SocialAllowedOperation[];
	retention: SocialRetentionPolicy;
	webhooks: SocialWebhookPolicy;
	review: SocialComplianceReview;
}

/** Planner-facing decision for one provider use-case operation. */
export type SocialOperationVisibility =
	| { visible: true; riskLevel: CapabilityRiskLevel }
	| { visible: false; reason: SocialBlockedReason };

const RISK_RANK: Readonly<Record<CapabilityRiskLevel, number>> = Object.freeze({
	R0: 0,
	R1: 1,
	R2: 2,
	R3: 3,
});

/** Hard risk floors: posting starts at R3 and drafting at R1; reads may be R0. */
export const SOCIAL_OPERATION_RISK_FLOORS: Readonly<
	Record<SocialOperationKind, CapabilityRiskLevel>
> = Object.freeze({
	read: "R0",
	draft: "R1",
	write: "R3",
});

const WRITE_CAPABLE_STATUSES: readonly SocialIntegrationStatus[] = [
	"official",
	"business",
	"bot",
];

const APP_REVIEW_CLEARED_STATES: readonly SocialAppReviewState[] = [
	"not_required",
	"approved",
];

function invalid(
	message: string,
	context: Record<string, unknown> = {},
): never {
	throw new ElizaError(message, {
		code: "INVALID_SOCIAL_COMPLIANCE_ENTRY",
		context,
		severity: "fatal",
	});
}

function record(value: unknown, contract: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return invalid(`${contract} must be an object.`, { contract });
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	raw: Record<string, unknown>,
	allowed: readonly string[],
	contract: string,
): void {
	const unexpectedFields = Object.keys(raw).filter(
		(key) => !allowed.includes(key),
	);
	if (unexpectedFields.length > 0) {
		invalid(`${contract} contains unsupported fields.`, {
			contract,
			unexpectedFieldCount: unexpectedFields.length,
		});
	}
}

function nonEmptyString(
	value: unknown,
	field: string,
	maxLength = 256,
): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > maxLength
	) {
		return invalid(`${field} must be a bounded non-empty string.`, { field });
	}
	return value.trim();
}

function booleanValue(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		return invalid(`${field} must be a boolean.`, { field });
	}
	return value;
}

function enumValue<T extends string>(
	value: unknown,
	values: readonly T[],
	field: string,
): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		return invalid(`${field} has an unsupported value.`, { field });
	}
	return value as T;
}

function isoTimestamp(value: unknown, field: string): string {
	const normalized = nonEmptyString(value, field);
	const parsed = Date.parse(normalized);
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
			normalized,
		) ||
		!Number.isFinite(parsed)
	) {
		return invalid(`${field} must be an ISO-8601 timestamp with a timezone.`, {
			field,
		});
	}
	return new Date(parsed).toISOString();
}

function normalizeAllowedOperation(
	value: unknown,
	field: string,
): SocialAllowedOperation {
	const raw = record(value, field);
	exactKeys(raw, ["operation", "kind", "riskLevel"], field);
	const kind = enumValue(raw.kind, SOCIAL_OPERATION_KINDS, `${field}.kind`);
	const riskLevel = enumValue(
		raw.riskLevel,
		CAPABILITY_RISK_LEVELS,
		`${field}.riskLevel`,
	);
	const floor = SOCIAL_OPERATION_RISK_FLOORS[kind];
	if (RISK_RANK[riskLevel] < RISK_RANK[floor]) {
		return invalid(`${field} cannot classify below the ${kind} risk floor.`, {
			field,
			kind,
			floor,
		});
	}
	return Object.freeze({
		operation: nonEmptyString(raw.operation, `${field}.operation`),
		kind,
		riskLevel,
	});
}

/** Validates and canonicalizes one compliance entry at a trust boundary. */
export function normalizeSocialComplianceEntry(
	value: unknown,
): SocialComplianceEntry {
	const raw = record(value, "SocialComplianceEntry");
	exactKeys(
		raw,
		[
			"registryVersion",
			"providerId",
			"useCase",
			"integrationStatus",
			"appReviewState",
			"allowedOperations",
			"retention",
			"webhooks",
			"review",
		],
		"SocialComplianceEntry",
	);
	if (raw.registryVersion !== SOCIAL_COMPLIANCE_REGISTRY_VERSION) {
		return invalid("SocialComplianceEntry has an unsupported version.");
	}
	const providerId = nonEmptyString(raw.providerId, "providerId");
	const useCase = nonEmptyString(raw.useCase, "useCase");
	const integrationStatus = enumValue(
		raw.integrationStatus,
		SOCIAL_INTEGRATION_STATUSES,
		"integrationStatus",
	);
	const appReviewState = enumValue(
		raw.appReviewState,
		SOCIAL_APP_REVIEW_STATES,
		"appReviewState",
	);
	if (!Array.isArray(raw.allowedOperations)) {
		return invalid("SocialComplianceEntry.allowedOperations must be an array.");
	}
	const allowedOperations = raw.allowedOperations.map((entry, index) =>
		normalizeAllowedOperation(entry, `allowedOperations[${index}]`),
	);
	if (
		new Set(allowedOperations.map(({ operation }) => operation)).size !==
		allowedOperations.length
	) {
		return invalid("SocialComplianceEntry operations must be unique.", {
			providerId,
			useCase,
		});
	}
	if (
		(integrationStatus === "unsupported" || integrationStatus === "handoff") &&
		allowedOperations.length > 0
	) {
		return invalid(
			"Unsupported and handoff integrations cannot allow operations.",
			{ providerId, useCase, integrationStatus },
		);
	}
	if (
		integrationStatus === "experimental" &&
		allowedOperations.some(({ kind }) => kind === "write")
	) {
		return invalid("Experimental integrations cannot allow write operations.", {
			providerId,
			useCase,
		});
	}
	const retentionRaw = record(raw.retention, "SocialComplianceEntry.retention");
	exactKeys(
		retentionRaw,
		["maxRetentionDays", "deletionPropagationSupported"],
		"SocialComplianceEntry.retention",
	);
	const maxRetentionDays = retentionRaw.maxRetentionDays;
	if (
		maxRetentionDays !== null &&
		(typeof maxRetentionDays !== "number" ||
			!Number.isInteger(maxRetentionDays) ||
			maxRetentionDays <= 0)
	) {
		return invalid(
			"retention.maxRetentionDays must be a positive integer or null.",
		);
	}
	const webhooksRaw = record(raw.webhooks, "SocialComplianceEntry.webhooks");
	exactKeys(
		webhooksRaw,
		["supported", "deduplicationRequired"],
		"SocialComplianceEntry.webhooks",
	);
	const webhookSupported = booleanValue(
		webhooksRaw.supported,
		"webhooks.supported",
	);
	const deduplicationRequired = booleanValue(
		webhooksRaw.deduplicationRequired,
		"webhooks.deduplicationRequired",
	);
	if (webhookSupported && !deduplicationRequired) {
		return invalid(
			"Webhook-capable integrations must require delivery deduplication.",
			{ providerId, useCase },
		);
	}
	const reviewRaw = record(raw.review, "SocialComplianceEntry.review");
	exactKeys(reviewRaw, ["owner", "reviewedAt"], "SocialComplianceEntry.review");
	return Object.freeze({
		registryVersion: SOCIAL_COMPLIANCE_REGISTRY_VERSION,
		providerId,
		useCase,
		integrationStatus,
		appReviewState,
		allowedOperations: Object.freeze(allowedOperations),
		retention: Object.freeze({
			maxRetentionDays,
			deletionPropagationSupported: booleanValue(
				retentionRaw.deletionPropagationSupported,
				"retention.deletionPropagationSupported",
			),
		}),
		webhooks: Object.freeze({
			supported: webhookSupported,
			deduplicationRequired,
		}),
		review: Object.freeze({
			owner: nonEmptyString(reviewRaw.owner, "review.owner"),
			reviewedAt: isoTimestamp(reviewRaw.reviewedAt, "review.reviewedAt"),
		}),
	});
}

function entryKey(providerId: string, useCase: string): string {
	return `${providerId} ${useCase}`;
}

/**
 * Deterministic registry of validated compliance entries. Projection methods
 * return only planner-visible capabilities; there is no API that exposes a
 * blocked operation as dispatchable.
 */
export class SocialComplianceRegistry {
	private readonly entries = new Map<string, SocialComplianceEntry>();

	register(value: unknown): SocialComplianceEntry {
		const entry = normalizeSocialComplianceEntry(value);
		const key = entryKey(entry.providerId, entry.useCase);
		if (this.entries.has(key)) {
			return invalid("Social compliance entry is already registered.", {
				providerId: entry.providerId,
				useCase: entry.useCase,
			});
		}
		this.entries.set(key, entry);
		return entry;
	}

	get(providerId: string, useCase: string): SocialComplianceEntry | null {
		return this.entries.get(entryKey(providerId, useCase)) ?? null;
	}

	list(): readonly SocialComplianceEntry[] {
		return Object.freeze([...this.entries.values()]);
	}

	/**
	 * Resolves whether one operation may be surfaced to the planner. An
	 * unregistered provider/use case/operation is blocked, not defaulted open.
	 */
	resolveOperationVisibility(
		providerId: string,
		useCase: string,
		operation: string,
	): SocialOperationVisibility {
		const entry = this.get(
			nonEmptyString(providerId, "providerId"),
			nonEmptyString(useCase, "useCase"),
		);
		if (!entry) {
			return Object.freeze({
				visible: false,
				reason: "integration_unsupported" as const,
			});
		}
		if (entry.integrationStatus === "unsupported") {
			return Object.freeze({
				visible: false,
				reason: "integration_unsupported" as const,
			});
		}
		if (entry.integrationStatus === "handoff") {
			return Object.freeze({
				visible: false,
				reason: "handoff_required" as const,
			});
		}
		const allowed = entry.allowedOperations.find(
			(candidate) => candidate.operation === operation,
		);
		if (!allowed) {
			return Object.freeze({
				visible: false,
				reason: "operation_not_allowed" as const,
			});
		}
		if (
			allowed.kind === "write" &&
			!WRITE_CAPABLE_STATUSES.includes(entry.integrationStatus)
		) {
			return Object.freeze({
				visible: false,
				reason: "experimental_writes_disabled" as const,
			});
		}
		if (
			allowed.kind !== "read" &&
			!APP_REVIEW_CLEARED_STATES.includes(entry.appReviewState)
		) {
			return Object.freeze({
				visible: false,
				reason: "app_review_incomplete" as const,
			});
		}
		return Object.freeze({ visible: true, riskLevel: allowed.riskLevel });
	}

	/**
	 * Projects one provider's planner-visible operations as connected-account
	 * capabilities. Blocked operations are omitted entirely, so a downstream
	 * `bindCapabilityRequest` cannot authorize them.
	 */
	projectPlannerCapabilities(
		providerId: string,
	): readonly ConnectedAccountCapability[] {
		const normalizedProviderId = nonEmptyString(providerId, "providerId");
		const capabilities: ConnectedAccountCapability[] = [];
		for (const entry of this.entries.values()) {
			if (entry.providerId !== normalizedProviderId) {
				continue;
			}
			for (const allowed of entry.allowedOperations) {
				const visibility = this.resolveOperationVisibility(
					entry.providerId,
					entry.useCase,
					allowed.operation,
				);
				if (!visibility.visible) {
					continue;
				}
				capabilities.push(
					Object.freeze({
						capabilityId: `${entry.useCase}.${allowed.operation}`,
						riskLevel: visibility.riskLevel,
						status: "available" as const,
					}),
				);
			}
		}
		return Object.freeze(capabilities);
	}
}

/**
 * First-party social provider baseline reviewed with this registry's
 * introduction. Bot-API providers ship reads, drafts, and R3 posting without
 * platform app review; business-API providers stay read/draft-only until their
 * platform review is approved; iMessage has no service API and remains a
 * device handoff with no planner-visible operations.
 */
export const FIRST_PARTY_SOCIAL_COMPLIANCE_ENTRIES: readonly SocialComplianceEntry[] =
	Object.freeze(
		[
			{
				providerId: "discord",
				useCase: "social.messaging",
				integrationStatus: "bot",
				appReviewState: "not_required",
				allowedOperations: [
					{ operation: "read_messages", kind: "read", riskLevel: "R0" },
					{ operation: "draft_message", kind: "draft", riskLevel: "R1" },
					{ operation: "post_message", kind: "write", riskLevel: "R3" },
				],
				retention: {
					maxRetentionDays: 90,
					deletionPropagationSupported: true,
				},
				webhooks: { supported: true, deduplicationRequired: true },
				review: {
					owner: "elizaOS integrations",
					reviewedAt: "2026-08-20T00:00:00Z",
				},
			},
			{
				providerId: "telegram",
				useCase: "social.messaging",
				integrationStatus: "bot",
				appReviewState: "not_required",
				allowedOperations: [
					{ operation: "read_messages", kind: "read", riskLevel: "R0" },
					{ operation: "draft_message", kind: "draft", riskLevel: "R1" },
					{ operation: "post_message", kind: "write", riskLevel: "R3" },
				],
				retention: {
					maxRetentionDays: 90,
					deletionPropagationSupported: true,
				},
				webhooks: { supported: true, deduplicationRequired: true },
				review: {
					owner: "elizaOS integrations",
					reviewedAt: "2026-08-20T00:00:00Z",
				},
			},
			{
				providerId: "slack",
				useCase: "social.messaging",
				integrationStatus: "bot",
				appReviewState: "not_required",
				allowedOperations: [
					{ operation: "read_messages", kind: "read", riskLevel: "R0" },
					{ operation: "draft_message", kind: "draft", riskLevel: "R1" },
					{ operation: "post_message", kind: "write", riskLevel: "R3" },
				],
				retention: {
					maxRetentionDays: 90,
					deletionPropagationSupported: true,
				},
				webhooks: { supported: true, deduplicationRequired: true },
				review: {
					owner: "elizaOS integrations",
					reviewedAt: "2026-08-20T00:00:00Z",
				},
			},
			{
				providerId: "matrix",
				useCase: "social.messaging",
				integrationStatus: "bot",
				appReviewState: "not_required",
				allowedOperations: [
					{ operation: "read_messages", kind: "read", riskLevel: "R0" },
					{ operation: "draft_message", kind: "draft", riskLevel: "R1" },
					{ operation: "post_message", kind: "write", riskLevel: "R3" },
				],
				retention: {
					maxRetentionDays: 90,
					deletionPropagationSupported: true,
				},
				webhooks: { supported: false, deduplicationRequired: false },
				review: {
					owner: "elizaOS integrations",
					reviewedAt: "2026-08-20T00:00:00Z",
				},
			},
			{
				providerId: "x",
				useCase: "social.publishing",
				integrationStatus: "business",
				appReviewState: "approved",
				allowedOperations: [
					{ operation: "read_timeline", kind: "read", riskLevel: "R0" },
					{ operation: "draft_post", kind: "draft", riskLevel: "R1" },
					{ operation: "publish_post", kind: "write", riskLevel: "R3" },
				],
				retention: {
					maxRetentionDays: 30,
					deletionPropagationSupported: true,
				},
				webhooks: { supported: false, deduplicationRequired: false },
				review: {
					owner: "elizaOS integrations",
					reviewedAt: "2026-08-20T00:00:00Z",
				},
			},
			{
				providerId: "instagram",
				useCase: "social.publishing",
				integrationStatus: "business",
				appReviewState: "not_submitted",
				allowedOperations: [
					{ operation: "read_media", kind: "read", riskLevel: "R0" },
					{ operation: "draft_post", kind: "draft", riskLevel: "R1" },
					{ operation: "publish_post", kind: "write", riskLevel: "R3" },
				],
				retention: {
					maxRetentionDays: 30,
					deletionPropagationSupported: true,
				},
				webhooks: { supported: true, deduplicationRequired: true },
				review: {
					owner: "elizaOS integrations",
					reviewedAt: "2026-08-20T00:00:00Z",
				},
			},
			{
				providerId: "whatsapp",
				useCase: "social.messaging",
				integrationStatus: "business",
				appReviewState: "not_submitted",
				allowedOperations: [
					{ operation: "read_messages", kind: "read", riskLevel: "R0" },
					{ operation: "draft_message", kind: "draft", riskLevel: "R1" },
					{ operation: "post_message", kind: "write", riskLevel: "R3" },
				],
				retention: {
					maxRetentionDays: 30,
					deletionPropagationSupported: true,
				},
				webhooks: { supported: true, deduplicationRequired: true },
				review: {
					owner: "elizaOS integrations",
					reviewedAt: "2026-08-20T00:00:00Z",
				},
			},
			{
				providerId: "imessage",
				useCase: "social.messaging",
				integrationStatus: "handoff",
				appReviewState: "not_required",
				allowedOperations: [],
				retention: {
					maxRetentionDays: null,
					deletionPropagationSupported: false,
				},
				webhooks: { supported: false, deduplicationRequired: false },
				review: {
					owner: "elizaOS integrations",
					reviewedAt: "2026-08-20T00:00:00Z",
				},
			},
		].map((entry) =>
			normalizeSocialComplianceEntry({
				registryVersion: SOCIAL_COMPLIANCE_REGISTRY_VERSION,
				...entry,
			}),
		),
	);

/** Builds a registry preloaded with the reviewed first-party baseline. */
export function createFirstPartySocialComplianceRegistry(): SocialComplianceRegistry {
	const registry = new SocialComplianceRegistry();
	for (const entry of FIRST_PARTY_SOCIAL_COMPLIANCE_ENTRIES) {
		registry.register(entry);
	}
	return registry;
}
