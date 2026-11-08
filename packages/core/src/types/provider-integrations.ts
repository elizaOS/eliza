/**
 * Provider-neutral contracts for connected accounts and capability policy.
 * Provider adapters expose opaque metadata through this module;
 * credentials and provider-specific request payloads never cross the boundary.
 */

import { createHash } from "node:crypto";

const sha256 = (input: Uint8Array): Uint8Array =>
	createHash("sha256").update(input).digest();

import { ElizaError } from "../errors";

export const PROVIDER_INTEGRATION_CONTRACT_VERSION = 2 as const;

export const CAPABILITY_RISK_LEVELS = ["R0", "R1", "R2", "R3"] as const;
export type CapabilityRiskLevel = (typeof CAPABILITY_RISK_LEVELS)[number];

export const CONNECTED_ACCOUNT_MODES = [
	"cloud",
	"connector",
	"local",
	"native",
] as const;
export type ConnectedAccountMode = (typeof CONNECTED_ACCOUNT_MODES)[number];

export const CONNECTED_ACCOUNT_STATUSES = [
	"connected",
	"disabled",
	"error",
	"reauth_required",
	"revoked",
	"unavailable",
] as const;
export type ConnectedAccountStatus =
	(typeof CONNECTED_ACCOUNT_STATUSES)[number];

export const CAPABILITY_UNAVAILABLE_CODES = [
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
] as const;
export type CapabilityUnavailableCode =
	(typeof CAPABILITY_UNAVAILABLE_CODES)[number];

export const CAPABILITY_POLICY_DENIAL_CODES = [
	"account_policy_denied",
	"capability_policy_denied",
	"organization_policy_denied",
	"risk_policy_denied",
	"user_policy_denied",
] as const;
export type CapabilityPolicyDenialCode =
	(typeof CAPABILITY_POLICY_DENIAL_CODES)[number];

export const CAPABILITY_EXECUTION_ERROR_CODES = [
	"authentication_failed",
	"authorization_failed",
	"conflict",
	"invalid_request",
	"provider_error",
	"rate_limited",
	"schema_drift",
	"timeout",
	"unknown_error",
] as const;
export type CapabilityExecutionErrorCode =
	(typeof CAPABILITY_EXECUTION_ERROR_CODES)[number];

export interface ConnectedAccountCapability {
	capabilityId: string;
	riskLevel: CapabilityRiskLevel;
	status: "available" | CapabilityUnavailableCode;
}

/**
 * Public account projection. `accountId` is an opaque capability handle, not
 * a provider account ID, credential row ID, email address, or token.
 */
export interface ConnectedAccount {
	contractVersion: typeof PROVIDER_INTEGRATION_CONTRACT_VERSION;
	accountId: string;
	providerId: string;
	mode: ConnectedAccountMode;
	status: ConnectedAccountStatus;
	displayName: string | null;
	capabilities: readonly ConnectedAccountCapability[];
	lastUsedAt: string | null;
}

/** Untrusted provider-neutral intent before deterministic account selection. */
export interface CapabilityRequest {
	contractVersion: typeof PROVIDER_INTEGRATION_CONTRACT_VERSION;
	requestId: string;
	capabilityId: string;
	operation: string;
	riskLevel: CapabilityRiskLevel;
	accountId: string | null;
	/** Provider-owned digest of canonical inputs; raw arguments stay private. */
	inputDigest: string;
}

export interface ConnectedAccountAuthorizationSnapshot {
	accountId: string;
	providerId: string;
	mode: ConnectedAccountMode;
	status: "connected";
	capability: ConnectedAccountCapability & { status: "available" };
}

/** Immutable account-selected request evaluated by policy before dispatch. */
export interface BoundCapabilityRequest {
	contractVersion: typeof PROVIDER_INTEGRATION_CONTRACT_VERSION;
	requestId: string;
	account: ConnectedAccountAuthorizationSnapshot;
	capabilityId: string;
	operation: string;
	riskLevel: CapabilityRiskLevel;
	inputDigest: string;
	requestDigest: string;
	boundAt: string;
}

interface CapabilityPolicyDecisionBase {
	contractVersion: typeof PROVIDER_INTEGRATION_CONTRACT_VERSION;
	decisionId: string;
	requestDigest: string;
	riskLevel: CapabilityRiskLevel;
	issuedAt: string;
	expiresAt: string;
}

/** Explicit policy result bound to one exact immutable request digest. */
export type CapabilityPolicyDecision =
	| (CapabilityPolicyDecisionBase & {
			outcome: "allowed";
			confirmation: "not_required";
	  })
	| (CapabilityPolicyDecisionBase & {
			outcome: "confirmation_required";
			confirmationId: string;
	  })
	| (CapabilityPolicyDecisionBase & {
			outcome: "denied";
			reasonCode: CapabilityPolicyDenialCode;
	  })
	| (CapabilityPolicyDecisionBase & {
			outcome: "unavailable";
			code: CapabilityUnavailableCode;
			retryable: boolean;
	  });

export interface CapabilityConfirmationGrant {
	contractVersion: typeof PROVIDER_INTEGRATION_CONTRACT_VERSION;
	confirmationId: string;
	decisionId: string;
	requestDigest: string;
	confirmedAt: string;
	expiresAt: string;
}

/** Explicit execution result that keeps designed-empty distinct from failure. */
export type CapabilityExecutionOutcome<T> =
	| {
			contractVersion: typeof PROVIDER_INTEGRATION_CONTRACT_VERSION;
			status: "success";
			value: T;
	  }
	| {
			contractVersion: typeof PROVIDER_INTEGRATION_CONTRACT_VERSION;
			status: "empty";
	  }
	| {
			contractVersion: typeof PROVIDER_INTEGRATION_CONTRACT_VERSION;
			status: "unavailable";
			code: CapabilityUnavailableCode;
			retryable: boolean;
	  }
	| {
			contractVersion: typeof PROVIDER_INTEGRATION_CONTRACT_VERSION;
			status: "error";
			code: CapabilityExecutionErrorCode;
			retryable: boolean;
	  };

const RISK_RANK: Readonly<Record<CapabilityRiskLevel, number>> = Object.freeze({
	R0: 0,
	R1: 1,
	R2: 2,
	R3: 3,
});

function invalid(
	message: string,
	context: Record<string, unknown> = {},
	code = "INVALID_PROVIDER_INTEGRATION_CONTRACT",
): never {
	throw new ElizaError(message, {
		code,
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

function version(raw: Record<string, unknown>, contract: string): void {
	if (raw.contractVersion !== PROVIDER_INTEGRATION_CONTRACT_VERSION) {
		invalid(`${contract} has an unsupported contract version.`, { contract });
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

function nullableString(value: unknown, field: string): string | null {
	return value === null ? null : nonEmptyString(value, field);
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

function digest(value: unknown, field: string): string {
	const normalized = nonEmptyString(value, field, 64).toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(normalized)) {
		return invalid(`${field} must be a SHA-256 digest.`, { field });
	}
	return normalized;
}

function isoTimestamp(value: unknown, field: string): string {
	const normalized = nonEmptyString(value, field);
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(
			normalized,
		);
	if (!match) {
		return invalid(`${field} must be an ISO-8601 timestamp with a timezone.`, {
			field,
		});
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
	const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [
		31,
		leapYear ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	][month - 1];
	const parsed = Date.parse(normalized);
	if (
		month < 1 ||
		month > 12 ||
		daysInMonth === undefined ||
		day < 1 ||
		day > daysInMonth ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		offsetHour > 23 ||
		offsetMinute > 59 ||
		!Number.isFinite(parsed)
	) {
		return invalid(`${field} must be a valid ISO-8601 timestamp.`, { field });
	}
	return new Date(parsed).toISOString();
}

function nullableTimestamp(value: unknown, field: string): string | null {
	return value === null ? null : isoTimestamp(value, field);
}

function stableJson(value: unknown): string {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
	}
	const raw = record(value, "digest input");
	return `{${Object.keys(raw)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(raw[key])}`)
		.join(",")}}`;
}

function sha256Hex(domain: string, value: unknown): string {
	const canonical = stableJson(value);
	return Array.from(
		sha256(new TextEncoder().encode(`${domain}\n${canonical}`)),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Validates and canonicalizes an account projection at a trust boundary. */
export function normalizeConnectedAccount(value: unknown): ConnectedAccount {
	const raw = record(value, "ConnectedAccount");
	exactKeys(
		raw,
		[
			"contractVersion",
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
	version(raw, "ConnectedAccount");
	if (!Array.isArray(raw.capabilities)) {
		return invalid("ConnectedAccount.capabilities must be an array.");
	}
	const capabilities = raw.capabilities.map((entry, index) => {
		const capability = record(entry, "ConnectedAccountCapability");
		exactKeys(
			capability,
			["capabilityId", "riskLevel", "status"],
			"ConnectedAccountCapability",
		);
		return Object.freeze({
			capabilityId: nonEmptyString(
				capability.capabilityId,
				`capabilities[${index}].capabilityId`,
			),
			riskLevel: enumValue(
				capability.riskLevel,
				CAPABILITY_RISK_LEVELS,
				`capabilities[${index}].riskLevel`,
			),
			status:
				capability.status === "available"
					? "available"
					: enumValue(
							capability.status,
							CAPABILITY_UNAVAILABLE_CODES,
							`capabilities[${index}].status`,
						),
		} satisfies ConnectedAccountCapability);
	});
	if (
		new Set(capabilities.map(({ capabilityId }) => capabilityId)).size !==
		capabilities.length
	) {
		return invalid("ConnectedAccount capability IDs must be unique.");
	}
	return Object.freeze({
		contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
		accountId: nonEmptyString(raw.accountId, "accountId"),
		providerId: nonEmptyString(raw.providerId, "providerId"),
		mode: enumValue(raw.mode, CONNECTED_ACCOUNT_MODES, "mode"),
		status: enumValue(raw.status, CONNECTED_ACCOUNT_STATUSES, "status"),
		displayName: nullableString(raw.displayName, "displayName"),
		capabilities: Object.freeze(capabilities),
		lastUsedAt: nullableTimestamp(raw.lastUsedAt, "lastUsedAt"),
	});
}

/** Validates and canonicalizes an untrusted capability request. */
export function normalizeCapabilityRequest(value: unknown): CapabilityRequest {
	const raw = record(value, "CapabilityRequest");
	exactKeys(
		raw,
		[
			"contractVersion",
			"requestId",
			"capabilityId",
			"operation",
			"riskLevel",
			"accountId",
			"inputDigest",
		],
		"CapabilityRequest",
	);
	version(raw, "CapabilityRequest");
	return Object.freeze({
		contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
		requestId: nonEmptyString(raw.requestId, "requestId"),
		capabilityId: nonEmptyString(raw.capabilityId, "capabilityId"),
		operation: nonEmptyString(raw.operation, "operation"),
		riskLevel: enumValue(raw.riskLevel, CAPABILITY_RISK_LEVELS, "riskLevel"),
		accountId: nullableString(raw.accountId, "accountId"),
		inputDigest: digest(raw.inputDigest, "inputDigest"),
	});
}

function requestDigestFields(
	request: Omit<BoundCapabilityRequest, "requestDigest">,
): Record<string, unknown> {
	return {
		contractVersion: request.contractVersion,
		requestId: request.requestId,
		accountId: request.account.accountId,
		providerId: request.account.providerId,
		mode: request.account.mode,
		accountCapabilityRiskLevel: request.account.capability.riskLevel,
		capabilityId: request.capabilityId,
		operation: request.operation,
		riskLevel: request.riskLevel,
		inputDigest: request.inputDigest,
		boundAt: request.boundAt,
	};
}

/** Computes the domain-separated digest policy and confirmation must bind. */
export function computeBoundCapabilityRequestDigest(
	request: Omit<BoundCapabilityRequest, "requestDigest">,
): string {
	return sha256Hex(
		"elizaos:provider-capability-request:v2",
		requestDigestFields(request),
	);
}

/** Revalidates a transported bound request and recomputes its exact digest. */
export function normalizeBoundCapabilityRequest(
	value: unknown,
): BoundCapabilityRequest {
	const raw = record(value, "BoundCapabilityRequest");
	exactKeys(
		raw,
		[
			"contractVersion",
			"requestId",
			"account",
			"capabilityId",
			"operation",
			"riskLevel",
			"inputDigest",
			"requestDigest",
			"boundAt",
		],
		"BoundCapabilityRequest",
	);
	version(raw, "BoundCapabilityRequest");
	const accountRaw = record(
		raw.account,
		"ConnectedAccountAuthorizationSnapshot",
	);
	exactKeys(
		accountRaw,
		["accountId", "providerId", "mode", "status", "capability"],
		"ConnectedAccountAuthorizationSnapshot",
	);
	if (accountRaw.status !== "connected") {
		return invalid("Bound capability account snapshot must be connected.");
	}
	const capabilityRaw = record(
		accountRaw.capability,
		"ConnectedAccountCapability",
	);
	exactKeys(
		capabilityRaw,
		["capabilityId", "riskLevel", "status"],
		"ConnectedAccountCapability",
	);
	if (capabilityRaw.status !== "available") {
		return invalid("Bound capability snapshot must be available.");
	}
	const account = Object.freeze({
		accountId: nonEmptyString(accountRaw.accountId, "account.accountId"),
		providerId: nonEmptyString(accountRaw.providerId, "account.providerId"),
		mode: enumValue(accountRaw.mode, CONNECTED_ACCOUNT_MODES, "account.mode"),
		status: "connected" as const,
		capability: Object.freeze({
			capabilityId: nonEmptyString(
				capabilityRaw.capabilityId,
				"account.capability.capabilityId",
			),
			riskLevel: enumValue(
				capabilityRaw.riskLevel,
				CAPABILITY_RISK_LEVELS,
				"account.capability.riskLevel",
			),
			status: "available" as const,
		}),
	});
	const capabilityId = nonEmptyString(raw.capabilityId, "capabilityId");
	const riskLevel = enumValue(
		raw.riskLevel,
		CAPABILITY_RISK_LEVELS,
		"riskLevel",
	);
	if (account.capability.capabilityId !== capabilityId) {
		return invalid(
			"Bound request capability does not match its account snapshot.",
		);
	}
	if (RISK_RANK[riskLevel] < RISK_RANK[account.capability.riskLevel]) {
		return invalid("Bound capability request downgraded catalog risk.");
	}
	const digestable = Object.freeze({
		contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
		requestId: nonEmptyString(raw.requestId, "requestId"),
		account,
		capabilityId,
		operation: nonEmptyString(raw.operation, "operation"),
		riskLevel,
		inputDigest: digest(raw.inputDigest, "inputDigest"),
		boundAt: isoTimestamp(raw.boundAt, "boundAt"),
	});
	const requestDigest = digest(raw.requestDigest, "requestDigest");
	if (computeBoundCapabilityRequestDigest(digestable) !== requestDigest) {
		return invalid("Bound capability request digest is stale or invalid.");
	}
	return Object.freeze({
		...digestable,
		requestDigest,
	});
}

/** Validates a versioned policy decision without treating it as trusted. */
export function normalizeCapabilityPolicyDecision(
	value: unknown,
): CapabilityPolicyDecision {
	const raw = record(value, "CapabilityPolicyDecision");
	version(raw, "CapabilityPolicyDecision");
	const base = {
		contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
		decisionId: nonEmptyString(raw.decisionId, "decisionId"),
		requestDigest: digest(raw.requestDigest, "requestDigest"),
		riskLevel: enumValue(raw.riskLevel, CAPABILITY_RISK_LEVELS, "riskLevel"),
		issuedAt: isoTimestamp(raw.issuedAt, "issuedAt"),
		expiresAt: isoTimestamp(raw.expiresAt, "expiresAt"),
	};
	if (Date.parse(base.expiresAt) <= Date.parse(base.issuedAt)) {
		return invalid("Capability policy decision must expire after issuance.");
	}
	switch (raw.outcome) {
		case "allowed":
			exactKeys(
				raw,
				[
					"contractVersion",
					"decisionId",
					"requestDigest",
					"riskLevel",
					"issuedAt",
					"expiresAt",
					"outcome",
					"confirmation",
				],
				"CapabilityPolicyDecision",
			);
			if (raw.confirmation !== "not_required") {
				return invalid(
					"Allowed policy decisions cannot carry reusable grants.",
				);
			}
			return Object.freeze({
				...base,
				outcome: "allowed",
				confirmation: "not_required",
			});
		case "confirmation_required":
			exactKeys(
				raw,
				[
					"contractVersion",
					"decisionId",
					"requestDigest",
					"riskLevel",
					"issuedAt",
					"expiresAt",
					"outcome",
					"confirmationId",
				],
				"CapabilityPolicyDecision",
			);
			return Object.freeze({
				...base,
				outcome: "confirmation_required",
				confirmationId: nonEmptyString(raw.confirmationId, "confirmationId"),
			});
		case "denied":
			exactKeys(
				raw,
				[
					"contractVersion",
					"decisionId",
					"requestDigest",
					"riskLevel",
					"issuedAt",
					"expiresAt",
					"outcome",
					"reasonCode",
				],
				"CapabilityPolicyDecision",
			);
			return Object.freeze({
				...base,
				outcome: "denied",
				reasonCode: enumValue(
					raw.reasonCode,
					CAPABILITY_POLICY_DENIAL_CODES,
					"reasonCode",
				),
			});
		case "unavailable":
			exactKeys(
				raw,
				[
					"contractVersion",
					"decisionId",
					"requestDigest",
					"riskLevel",
					"issuedAt",
					"expiresAt",
					"outcome",
					"code",
					"retryable",
				],
				"CapabilityPolicyDecision",
			);
			return Object.freeze({
				...base,
				outcome: "unavailable",
				code: enumValue(raw.code, CAPABILITY_UNAVAILABLE_CODES, "code"),
				retryable: booleanValue(raw.retryable, "retryable"),
			});
		default:
			return invalid("CapabilityPolicyDecision outcome is unsupported.", {
				contract: "CapabilityPolicyDecision",
			});
	}
}

/** Computes the domain-separated identity of the complete policy snapshot. */
export function computeCapabilityPolicyDecisionDigest(
	decision: CapabilityPolicyDecision,
): string {
	return sha256Hex("elizaos:provider-policy-decision:v2", decision);
}

/** Validates and freezes a transported confirmation grant without trusting it. */
export function normalizeCapabilityConfirmationGrant(
	value: unknown,
): CapabilityConfirmationGrant {
	const raw = record(value, "CapabilityConfirmationGrant");
	exactKeys(
		raw,
		[
			"contractVersion",
			"confirmationId",
			"decisionId",
			"requestDigest",
			"confirmedAt",
			"expiresAt",
		],
		"CapabilityConfirmationGrant",
	);
	version(raw, "CapabilityConfirmationGrant");
	const grant = Object.freeze({
		contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
		confirmationId: nonEmptyString(raw.confirmationId, "confirmationId"),
		decisionId: nonEmptyString(raw.decisionId, "decisionId"),
		requestDigest: digest(raw.requestDigest, "requestDigest"),
		confirmedAt: isoTimestamp(raw.confirmedAt, "confirmedAt"),
		expiresAt: isoTimestamp(raw.expiresAt, "expiresAt"),
	});
	if (Date.parse(grant.expiresAt) <= Date.parse(grant.confirmedAt)) {
		return invalid("Capability confirmation must expire after approval.");
	}
	return grant;
}

/** Computes the domain-separated identity of the complete confirmation grant. */
export function computeCapabilityConfirmationGrantDigest(
	grant: CapabilityConfirmationGrant,
): string {
	return sha256Hex("elizaos:provider-confirmation-grant:v2", grant);
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
	version(raw, "CapabilityExecutionOutcome");
	switch (raw.status) {
		case "success":
			exactKeys(
				raw,
				["contractVersion", "status", "value"],
				"CapabilityExecutionOutcome",
			);
			return Object.freeze({
				contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
				status: "success",
				value: normalizeValue(raw.value),
			});
		case "empty":
			exactKeys(
				raw,
				["contractVersion", "status"],
				"CapabilityExecutionOutcome",
			);
			return Object.freeze({
				contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
				status: "empty",
			});
		case "unavailable":
			exactKeys(
				raw,
				["contractVersion", "status", "code", "retryable"],
				"CapabilityExecutionOutcome",
			);
			return Object.freeze({
				contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
				status: "unavailable",
				code: enumValue(raw.code, CAPABILITY_UNAVAILABLE_CODES, "code"),
				retryable: booleanValue(raw.retryable, "retryable"),
			});
		case "error":
			exactKeys(
				raw,
				["contractVersion", "status", "code", "retryable"],
				"CapabilityExecutionOutcome",
			);
			return Object.freeze({
				contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
				status: "error",
				code: enumValue(raw.code, CAPABILITY_EXECUTION_ERROR_CODES, "code"),
				retryable: booleanValue(raw.retryable, "retryable"),
			});
		default:
			return invalid("CapabilityExecutionOutcome status is unsupported.", {
				contract: "CapabilityExecutionOutcome",
			});
	}
}
