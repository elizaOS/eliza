/**
 * Provider-neutral contracts for connected accounts, capability policy, and
 * integration outcomes. These wire types expose opaque references and policy
 * state without allowing provider credentials or provider-specific payloads
 * into the runtime contract.
 */

import { ElizaError } from "../errors";
import { type EffectReceipt, normalizeEffectReceipt } from "./effects";

/** Stable policy tier applied before a provider capability is selected. */
export type CapabilityRiskLevel = "R0" | "R1" | "R2" | "R3";

/** How the account is reached without exposing its credential representation. */
export type ConnectedAccountMode = "cloud" | "connector" | "local" | "native";

/** User-visible lifecycle state for an opaque connected account. */
export type ConnectedAccountStatus =
	| "connected"
	| "disabled"
	| "error"
	| "reauth_required"
	| "revoked"
	| "unavailable";

/** Why a capability cannot currently be offered to the planner. */
export type CapabilityUnavailableCode =
	| "account_disabled"
	| "account_error"
	| "account_revoked"
	| "cost_blocked"
	| "needs_admin"
	| "needs_review"
	| "needs_scope"
	| "not_configured"
	| "provider_unavailable"
	| "unsupported";

/** Capability projected from a provider account into a normalized catalog. */
export interface ConnectedAccountCapability {
	capabilityId: string;
	riskLevel: CapabilityRiskLevel;
	status: "available" | CapabilityUnavailableCode;
}

/**
 * Public account projection. `accountId` is an opaque capability handle, not a
 * provider account ID, credential ID, email address, or access token.
 */
export interface ConnectedAccount {
	accountId: string;
	providerId: string;
	mode: ConnectedAccountMode;
	status: ConnectedAccountStatus;
	displayName: string | null;
	capabilities: readonly ConnectedAccountCapability[];
	lastUsedAt: string | null;
}

/** Provider-neutral request evaluated before adapter or account selection. */
export interface CapabilityRequest {
	requestId: string;
	capabilityId: string;
	operation: string;
	riskLevel: CapabilityRiskLevel;
	accountId: string | null;
}

interface CapabilityPolicyDecisionBase {
	decisionId: string;
	requestId: string;
	riskLevel: CapabilityRiskLevel;
}

/** Explicit policy result; non-allowed outcomes cannot be mistaken for access. */
export type CapabilityPolicyDecision =
	| (CapabilityPolicyDecisionBase & {
			outcome: "allowed";
			confirmation: "already_granted" | "not_required";
	  })
	| (CapabilityPolicyDecisionBase & {
			outcome: "confirmation_required";
			confirmationId: string;
			expiresAt: string;
	  })
	| (CapabilityPolicyDecisionBase & {
			outcome: "denied";
			reasonCode: string;
	  })
	| (CapabilityPolicyDecisionBase & {
			outcome: "unavailable";
			code: CapabilityUnavailableCode;
			retryable: boolean;
	  });

/** Mutation proof bound to the account, capability, and policy decision used. */
export interface CapabilityActionReceipt {
	accountId: string;
	capabilityId: string;
	policyDecisionId: string;
	effect: EffectReceipt;
}

/** Explicit execution result that keeps designed-empty distinct from failure. */
export type CapabilityExecutionOutcome<T> =
	| { status: "success"; value: T }
	| { status: "empty" }
	| {
			status: "unavailable";
			code: CapabilityUnavailableCode;
			retryable: boolean;
	  }
	| {
			status: "error";
			code: string;
			retryable: boolean;
	  };

const ACCOUNT_MODES = new Set<ConnectedAccountMode>([
	"cloud",
	"connector",
	"local",
	"native",
]);
const ACCOUNT_STATUSES = new Set<ConnectedAccountStatus>([
	"connected",
	"disabled",
	"error",
	"reauth_required",
	"revoked",
	"unavailable",
]);
const RISK_LEVELS = new Set<CapabilityRiskLevel>(["R0", "R1", "R2", "R3"]);
const UNAVAILABLE_CODES = new Set<CapabilityUnavailableCode>([
	"account_disabled",
	"account_error",
	"account_revoked",
	"cost_blocked",
	"needs_admin",
	"needs_review",
	"needs_scope",
	"not_configured",
	"provider_unavailable",
	"unsupported",
]);

function invalid(message: string, context: Record<string, unknown>): never {
	throw new ElizaError(message, {
		code: "INVALID_PROVIDER_INTEGRATION_CONTRACT",
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
	const unexpected = Object.keys(raw).filter((key) => !allowed.includes(key));
	if (unexpected.length > 0) {
		invalid(`${contract} contains unsupported fields.`, {
			contract,
			unexpected,
		});
	}
}

function string(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		return invalid(`${field} must be a non-empty string.`, { field });
	}
	return value.trim();
}

function nullableString(value: unknown, field: string): string | null {
	return value === null ? null : string(value, field);
}

function timestamp(value: unknown, field: string): string {
	const normalized = string(value, field);
	if (!Number.isFinite(Date.parse(normalized))) {
		return invalid(`${field} must be an ISO-8601 timestamp.`, { field });
	}
	return normalized;
}

function nullableTimestamp(value: unknown, field: string): string | null {
	return value === null ? null : timestamp(value, field);
}

function enumeration<T extends string>(
	value: unknown,
	values: ReadonlySet<T>,
	field: string,
): T {
	if (typeof value !== "string" || !values.has(value as T)) {
		return invalid(`${field} has an unsupported value.`, { field, value });
	}
	return value as T;
}

/** Validates and canonicalizes an account projection at a trust boundary. */
export function normalizeConnectedAccount(value: unknown): ConnectedAccount {
	const raw = record(value, "ConnectedAccount");
	exactKeys(
		raw,
		[
			"accountId",
			"providerId",
			"mode",
			"status",
			"displayName",
			"capabilities",
			"lastUsedAt",
		],
		"ConnectedAccount",
	);
	if (!Array.isArray(raw.capabilities)) {
		return invalid("ConnectedAccount.capabilities must be an array.", {});
	}
	const capabilities = raw.capabilities.map((value, index) => {
		const capability = record(value, "ConnectedAccountCapability");
		exactKeys(
			capability,
			["capabilityId", "riskLevel", "status"],
			"ConnectedAccountCapability",
		);
		return {
			capabilityId: string(
				capability.capabilityId,
				`capabilities[${index}].capabilityId`,
			),
			riskLevel: enumeration(
				capability.riskLevel,
				RISK_LEVELS,
				`capabilities[${index}].riskLevel`,
			),
			status:
				capability.status === "available"
					? "available"
					: enumeration(
							capability.status,
							UNAVAILABLE_CODES,
							`capabilities[${index}].status`,
						),
		} satisfies ConnectedAccountCapability;
	});
	const capabilityIds = new Set(
		capabilities.map(({ capabilityId }) => capabilityId),
	);
	if (capabilityIds.size !== capabilities.length) {
		return invalid("ConnectedAccount capabilities must have unique IDs.", {});
	}
	return Object.freeze({
		accountId: string(raw.accountId, "accountId"),
		providerId: string(raw.providerId, "providerId"),
		mode: enumeration(raw.mode, ACCOUNT_MODES, "mode"),
		status: enumeration(raw.status, ACCOUNT_STATUSES, "status"),
		displayName: nullableString(raw.displayName, "displayName"),
		capabilities: Object.freeze(capabilities),
		lastUsedAt: nullableTimestamp(raw.lastUsedAt, "lastUsedAt"),
	});
}

/** Validates and canonicalizes a capability request at a trust boundary. */
export function normalizeCapabilityRequest(value: unknown): CapabilityRequest {
	const raw = record(value, "CapabilityRequest");
	exactKeys(
		raw,
		["requestId", "capabilityId", "operation", "riskLevel", "accountId"],
		"CapabilityRequest",
	);
	return Object.freeze({
		requestId: string(raw.requestId, "requestId"),
		capabilityId: string(raw.capabilityId, "capabilityId"),
		operation: string(raw.operation, "operation"),
		riskLevel: enumeration(raw.riskLevel, RISK_LEVELS, "riskLevel"),
		accountId: nullableString(raw.accountId, "accountId"),
	});
}

/** Validates and canonicalizes a policy decision at a trust boundary. */
export function normalizeCapabilityPolicyDecision(
	value: unknown,
): CapabilityPolicyDecision {
	const raw = record(value, "CapabilityPolicyDecision");
	const base = {
		decisionId: string(raw.decisionId, "decisionId"),
		requestId: string(raw.requestId, "requestId"),
		riskLevel: enumeration(raw.riskLevel, RISK_LEVELS, "riskLevel"),
	};
	switch (raw.outcome) {
		case "allowed":
			exactKeys(
				raw,
				["decisionId", "requestId", "riskLevel", "outcome", "confirmation"],
				"CapabilityPolicyDecision",
			);
			if (
				raw.confirmation !== "already_granted" &&
				raw.confirmation !== "not_required"
			) {
				return invalid(
					"Allowed decisions require a valid confirmation state.",
					{},
				);
			}
			return Object.freeze({
				...base,
				outcome: raw.outcome,
				confirmation: raw.confirmation,
			});
		case "confirmation_required":
			exactKeys(
				raw,
				[
					"decisionId",
					"requestId",
					"riskLevel",
					"outcome",
					"confirmationId",
					"expiresAt",
				],
				"CapabilityPolicyDecision",
			);
			return Object.freeze({
				...base,
				outcome: raw.outcome,
				confirmationId: string(raw.confirmationId, "confirmationId"),
				expiresAt: timestamp(raw.expiresAt, "expiresAt"),
			});
		case "denied":
			exactKeys(
				raw,
				["decisionId", "requestId", "riskLevel", "outcome", "reasonCode"],
				"CapabilityPolicyDecision",
			);
			return Object.freeze({
				...base,
				outcome: raw.outcome,
				reasonCode: string(raw.reasonCode, "reasonCode"),
			});
		case "unavailable":
			exactKeys(
				raw,
				[
					"decisionId",
					"requestId",
					"riskLevel",
					"outcome",
					"code",
					"retryable",
				],
				"CapabilityPolicyDecision",
			);
			if (typeof raw.retryable !== "boolean") {
				return invalid(
					"Unavailable decisions require a retryable boolean.",
					{},
				);
			}
			return Object.freeze({
				...base,
				outcome: raw.outcome,
				code: enumeration(raw.code, UNAVAILABLE_CODES, "code"),
				retryable: raw.retryable,
			});
		default:
			return invalid("CapabilityPolicyDecision outcome is unsupported.", {
				outcome: raw.outcome,
			});
	}
}

/** Validates a mutation receipt and its provider-neutral policy bindings. */
export function normalizeCapabilityActionReceipt(
	value: unknown,
): CapabilityActionReceipt {
	const raw = record(value, "CapabilityActionReceipt");
	exactKeys(
		raw,
		["accountId", "capabilityId", "policyDecisionId", "effect"],
		"CapabilityActionReceipt",
	);
	return Object.freeze({
		accountId: string(raw.accountId, "accountId"),
		capabilityId: string(raw.capabilityId, "capabilityId"),
		policyDecisionId: string(raw.policyDecisionId, "policyDecisionId"),
		effect: normalizeEffectReceipt(raw.effect),
	});
}

/**
 * Validates an execution envelope while leaving successful domain payload
 * validation to the owning capability adapter.
 */
export function normalizeCapabilityExecutionOutcome<T>(
	value: unknown,
	normalizeValue: (value: unknown) => T,
): CapabilityExecutionOutcome<T> {
	const raw = record(value, "CapabilityExecutionOutcome");
	switch (raw.status) {
		case "success":
			exactKeys(raw, ["status", "value"], "CapabilityExecutionOutcome");
			return Object.freeze({
				status: raw.status,
				value: normalizeValue(raw.value),
			});
		case "empty":
			exactKeys(raw, ["status"], "CapabilityExecutionOutcome");
			return Object.freeze({ status: raw.status });
		case "unavailable":
			exactKeys(
				raw,
				["status", "code", "retryable"],
				"CapabilityExecutionOutcome",
			);
			if (typeof raw.retryable !== "boolean") {
				return invalid("Unavailable outcomes require a retryable boolean.", {});
			}
			return Object.freeze({
				status: raw.status,
				code: enumeration(raw.code, UNAVAILABLE_CODES, "code"),
				retryable: raw.retryable,
			});
		case "error":
			exactKeys(
				raw,
				["status", "code", "retryable"],
				"CapabilityExecutionOutcome",
			);
			if (typeof raw.retryable !== "boolean") {
				return invalid("Error outcomes require a retryable boolean.", {});
			}
			return Object.freeze({
				status: raw.status,
				code: string(raw.code, "code"),
				retryable: raw.retryable,
			});
		default:
			return invalid("CapabilityExecutionOutcome status is unsupported.", {
				status: raw.status,
			});
	}
}
