/**
 * Canonical, browser-safe contracts for semantic browser and native computer
 * control. Adapters advertise capabilities before dispatch, bind every action
 * to one session and surface generation, and return side-effect-safe outcomes
 * that reuse the runtime's existing effect receipts as mutation proof.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { ElizaError } from "../errors.ts";
import {
	type EffectReceipt,
	normalizeEffectReceipts,
} from "../types/effects.ts";

export const INTERACTION_CONTRACT_VERSION = 2 as const;

export const INTERACTION_CONTROL_PLANES = ["browser", "computer"] as const;
export type InteractionControlPlane =
	(typeof INTERACTION_CONTROL_PLANES)[number];

export const INTERACTION_SURFACE_KINDS = [
	"browser_tab",
	"browser_frame",
	"native_window",
	"display",
	"virtual_desktop",
	"dialog",
	"picture_in_picture",
] as const;
export type InteractionSurfaceKind = (typeof INTERACTION_SURFACE_KINDS)[number];

export const INTERACTION_OBSERVATION_CHANNELS = [
	"dom",
	"browser_accessibility",
	"os_accessibility",
	"screenshot",
	"video",
	"ocr",
	"browser_events",
	"window_geometry",
] as const;
export type InteractionObservationChannel =
	(typeof INTERACTION_OBSERVATION_CHANNELS)[number];

export const INTERACTION_ACTION_KINDS = [
	"observe",
	"click",
	"double_click",
	"context_click",
	"hover",
	"drag",
	"scroll",
	"type_text",
	"set_value",
	"press_key",
	"select",
	"focus",
	"navigate",
	"evaluate",
	"upload",
	"download",
	"open",
	"close",
	"back",
	"forward",
	"reload",
	"wait",
	"switch_tab",
	"create_tab",
	"close_tab",
	"move_window",
	"resize_window",
	"launch_app",
	"quit_app",
	"set_clipboard",
	"get_clipboard",
	"request_permission",
	"start_capture",
	"stop_capture",
] as const;
export type InteractionActionKind = (typeof INTERACTION_ACTION_KINDS)[number];

export const INTERACTION_OUTCOME_STATUSES = [
	"SUCCEEDED",
	"FAILED_NO_EFFECT",
	"UNCERTAIN_EFFECT",
	"BLOCKED_BY_POLICY",
	"NEEDS_CONFIRMATION",
	"UNSUPPORTED",
	"STALE_OBSERVATION",
	"LEASE_CONFLICT",
] as const;
export type InteractionOutcomeStatus =
	(typeof INTERACTION_OUTCOME_STATUSES)[number];

export const INTERACTION_SESSION_STATES = [
	"creating",
	"ready",
	"running",
	"paused",
	"awaiting_confirmation",
	"user_controlled",
	"stopping",
	"stopped",
	"failed",
] as const;
export type InteractionSessionState =
	(typeof INTERACTION_SESSION_STATES)[number];

export const INTERACTION_ISOLATION_MODES = [
	"shared_desktop",
	"managed_browser",
	"virtual_display",
	"virtual_machine",
	"remote_session",
] as const;
export type InteractionIsolationMode =
	(typeof INTERACTION_ISOLATION_MODES)[number];

export const INTERACTION_PROFILE_MODES = [
	"none",
	"managed",
	"existing_explicit",
] as const;
export type InteractionProfileMode = (typeof INTERACTION_PROFILE_MODES)[number];

export const INTERACTION_BACKGROUND_MODES = [
	"none",
	"semantic_only",
	"isolated_session",
	"full",
] as const;
export type InteractionBackgroundMode =
	(typeof INTERACTION_BACKGROUND_MODES)[number];

export const INTERACTION_CONCURRENCY_MODES = [
	"single_surface",
	"multi_surface_shared_input",
	"isolated_sessions",
] as const;
export type InteractionConcurrencyMode =
	(typeof INTERACTION_CONCURRENCY_MODES)[number];

export const INTERACTION_LEASE_RESOURCE_KINDS = [
	"browser_attachment",
	"focus",
	"clipboard",
	"keyboard",
	"physical_pointer",
	"credential_injection",
] as const;
export type InteractionLeaseResourceKind =
	(typeof INTERACTION_LEASE_RESOURCE_KINDS)[number];

export interface InteractionRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface InteractionPoint {
	x: number;
	y: number;
}

export interface InteractionSurfaceRef {
	sessionId: string;
	adapterId: string;
	surfaceId: string;
	kind: InteractionSurfaceKind;
	generation: number;
	parentSurfaceId: string | null;
}

/** Proof that an owner explicitly granted one session access to an existing profile. */
export interface InteractionProfileGrantRef {
	grantId: string;
	sessionId: string;
	ownerId: string;
	adapterId: string;
	profileHandle: string;
	issuedAt: string;
	expiresAt: string;
}

export interface InteractionProfileGrantVerifier {
	verify(
		grant: InteractionProfileGrantRef,
		context: {
			sessionId: string;
			ownerId: string;
			adapterId: string;
			now: number;
		},
	): boolean;
}

export interface InteractionSession {
	contractVersion: typeof INTERACTION_CONTRACT_VERSION;
	sessionId: string;
	ownerId: string;
	adapterId: string;
	state: InteractionSessionState;
	isolationMode: InteractionIsolationMode;
	profileMode: InteractionProfileMode;
	generation: number;
	createdAt: string;
	updatedAt: string;
	expiresAt: string | null;
	profileGrant: InteractionProfileGrantRef | null;
	surfaces: readonly InteractionSurfaceRef[];
}

export interface InteractionCapabilityLimitation {
	code: string;
	description: string;
	actionKinds: readonly InteractionActionKind[];
	surfaceKinds: readonly InteractionSurfaceKind[];
}

export interface InteractionCapabilitySet {
	contractVersion: typeof INTERACTION_CONTRACT_VERSION;
	adapterId: string;
	controlPlanes: readonly InteractionControlPlane[];
	surfaceKinds: readonly InteractionSurfaceKind[];
	observationChannels: readonly InteractionObservationChannel[];
	actionKinds: readonly InteractionActionKind[];
	background: {
		mode: InteractionBackgroundMode;
		requiresForeground: readonly InteractionActionKind[];
	};
	profileAccess: {
		modes: readonly InteractionProfileMode[];
		requiresExplicitGrant: boolean;
	};
	concurrency: {
		mode: InteractionConcurrencyMode;
		maxSessions: number | null;
		sharedResources: readonly InteractionLeaseResourceKind[];
	};
	limitations: readonly InteractionCapabilityLimitation[];
}

export interface InteractionArtifactRef {
	kind: "semantic_tree" | "screenshot" | "video" | "event_log" | "ocr";
	uri: string;
	sha256: string;
	mimeType: string | null;
	width: number | null;
	height: number | null;
}

export interface InteractionRedaction {
	kind: "secure_field" | "policy_region" | "credential" | "personal_data";
	bounds: InteractionRect | null;
	reason: string;
}

export const INTERACTION_TRACE_EVENT_KINDS = [
	"observation_captured",
	"action_dispatched",
	"action_completed",
	"confirmation_requested",
	"policy_blocked",
	"lease_acquired",
	"lease_released",
	"redaction_applied",
	"session_state_changed",
] as const;
export type InteractionTraceEventKind =
	(typeof INTERACTION_TRACE_EVENT_KINDS)[number];

export const INTERACTION_TRACE_REDACTION_REASONS = [
	"policy",
	"secure_input",
	"credential",
	"personal_data",
	"user_redaction",
] as const;
export type InteractionTraceRedactionReason =
	(typeof INTERACTION_TRACE_REDACTION_REASONS)[number];

export type InteractionTraceAttribute =
	| {
			classification: "public";
			name: string;
			value: string | number | boolean | null;
			opaqueToken: null;
			reason: null;
	  }
	| {
			classification: "personal_data" | "credential" | "secure_field";
			name: string;
			value: null;
			opaqueToken: string | null;
			reason: InteractionTraceRedactionReason;
	  };

/** Metadata-only trace record; sensitive values are structurally redacted. */
export interface InteractionTraceEvent {
	eventId: string;
	sessionId: string;
	adapterId: string;
	surfaceId: string | null;
	actionId: string | null;
	observationId: string | null;
	sequence: number;
	occurredAt: string;
	kind: InteractionTraceEventKind;
	status: InteractionOutcomeStatus | null;
	attributes: readonly InteractionTraceAttribute[];
}

export interface InteractionObservation {
	contractVersion: typeof INTERACTION_CONTRACT_VERSION;
	observationId: string;
	sessionId: string;
	adapterId: string;
	surface: InteractionSurfaceRef;
	sequence: number;
	observedAt: string;
	channels: readonly InteractionObservationChannel[];
	artifacts: readonly InteractionArtifactRef[];
	viewport: InteractionRect | null;
	cursor: InteractionPoint | null;
	redactions: readonly InteractionRedaction[];
	traceEvents: readonly InteractionTraceEvent[];
}

interface InteractionActionBase<K extends InteractionActionKind, P> {
	contractVersion: typeof INTERACTION_CONTRACT_VERSION;
	actionId: string;
	sessionId: string;
	adapterId: string;
	surface: InteractionSurfaceRef;
	kind: K;
	payload: P;
	observationId: string | null;
	observationSequence: number | null;
	requestedAt: string;
	confirmationGrant: InteractionConfirmationGrant | null;
	leaseIds: readonly string[];
}

export type InteractionAction =
	| InteractionActionBase<"observe", Record<string, never>>
	| InteractionActionBase<
			"click" | "double_click" | "context_click" | "hover",
			{ elementId: string | null; point: InteractionPoint | null }
	  >
	| InteractionActionBase<
			"drag",
			{
				fromElementId: string | null;
				toElementId: string | null;
				from: InteractionPoint | null;
				to: InteractionPoint | null;
			}
	  >
	| InteractionActionBase<
			"scroll",
			{ deltaX: number; deltaY: number; elementId: string | null }
	  >
	| InteractionActionBase<
			"type_text" | "set_value",
			{ text: string; elementId: string | null; sensitive: boolean }
	  >
	| InteractionActionBase<"press_key", { key: string }>
	| InteractionActionBase<"select", { elementId: string; value: string }>
	| InteractionActionBase<"focus", { elementId: string | null }>
	| InteractionActionBase<"navigate" | "open" | "create_tab", { url: string }>
	| InteractionActionBase<"evaluate", { expression: string }>
	| InteractionActionBase<
			"upload",
			{ elementId: string; fileHandles: string[] }
	  >
	| InteractionActionBase<
			"download",
			{ elementId: string | null; url: string | null }
	  >
	| InteractionActionBase<
			"close" | "back" | "forward" | "reload" | "close_tab",
			Record<string, never>
	  >
	| InteractionActionBase<"wait", { condition: string; timeoutMs: number }>
	| InteractionActionBase<"switch_tab", { tabId: string }>
	| InteractionActionBase<"move_window", { point: InteractionPoint }>
	| InteractionActionBase<"resize_window", { width: number; height: number }>
	| InteractionActionBase<"launch_app" | "quit_app", { applicationId: string }>
	| InteractionActionBase<"set_clipboard", { text: string; sensitive: boolean }>
	| InteractionActionBase<"get_clipboard", Record<string, never>>
	| InteractionActionBase<"request_permission", { permission: string }>
	| InteractionActionBase<
			"start_capture",
			{ framesPerSecond: number; includeAudio: boolean }
	  >
	| InteractionActionBase<"stop_capture", Record<string, never>>;

export interface InteractionConfirmationPreview {
	confirmationId: string;
	actionId: string;
	taxonomy: string;
	origin: string | null;
	destination: string | null;
	disclosures: readonly string[];
	consequence: string;
	actionDigest: string;
	requestedAt: string;
	expiresAt: string;
}

/** Host-issued proof that the exact previewed action was approved. */
export interface InteractionConfirmationGrant {
	confirmationId: string;
	actionId: string;
	actionDigest: string;
	confirmedAt: string;
	expiresAt: string;
}

export interface InteractionConfirmationGrantVerifier {
	verify(
		grant: InteractionConfirmationGrant,
		action: InteractionAction,
		now: number,
	): boolean;
}

/** Atomically verify and consume a current grant, rejecting every replay. */
export interface InteractionConfirmationGrantConsumer {
	consume(
		grant: InteractionConfirmationGrant,
		action: InteractionAction,
		now: number,
	): Promise<void>;
}

export interface InteractionActionError {
	code: string;
	message: string;
	retryable: boolean;
}

export interface InteractionActionEvidence {
	beforeObservationId: string | null;
	afterObservationId: string | null;
	adapterTraceId: string | null;
	actualTarget: string | null;
}

interface InteractionActionResultBase {
	contractVersion: typeof INTERACTION_CONTRACT_VERSION;
	actionId: string;
	sessionId: string;
	adapterId: string;
	startedAt: string;
	completedAt: string;
	evidence: InteractionActionEvidence;
	effectReceipts: readonly EffectReceipt[];
	observation: InteractionObservation | null;
	traceEvents: readonly InteractionTraceEvent[];
}

export type InteractionActionResult =
	| (InteractionActionResultBase & {
			status: "SUCCEEDED";
			error: null;
			confirmation: null;
	  })
	| (InteractionActionResultBase & {
			status: "NEEDS_CONFIRMATION";
			error: null;
			confirmation: InteractionConfirmationPreview;
	  })
	| (InteractionActionResultBase & {
			status: Exclude<
				InteractionOutcomeStatus,
				"SUCCEEDED" | "NEEDS_CONFIRMATION"
			>;
			error: InteractionActionError;
			confirmation: null;
	  });

export interface InteractionLease {
	leaseId: string;
	sessionId: string;
	ownerId: string;
	resourceKind: InteractionLeaseResourceKind;
	resourceId: string;
	generation: number;
	acquiredAt: string;
	expiresAt: string;
}

export interface AcquireInteractionLeaseRequest {
	leaseId: string;
	sessionId: string;
	ownerId: string;
	resourceKind: InteractionLeaseResourceKind;
	resourceId: string;
	generation: number;
	ttlMs: number;
}

export interface InteractionLeaseRequirement {
	resourceKind: InteractionLeaseResourceKind;
	resourceId: string;
}

const authorizedInteractionAction = Symbol("authorizedInteractionAction");

/** An action that passed the host's atomic pre-dispatch authorization gate. */
export type AuthorizedInteractionAction = InteractionAction & {
	readonly [authorizedInteractionAction]: number;
};

export interface InteractionAdapter {
	readonly id: string;
	capabilities(): Promise<InteractionCapabilitySet>;
	observe(
		session: InteractionSession,
		surface: InteractionSurfaceRef,
	): Promise<InteractionObservation>;
	execute(
		action: AuthorizedInteractionAction,
	): Promise<InteractionActionResult>;
}

type Clock = () => number;

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function invalid(
	message: string,
	context: Record<string, unknown> = {},
): never {
	throw new ElizaError(message, {
		code: "INVALID_INTERACTION_CONTRACT",
		context,
		severity: "fatal",
	});
}

function nonEmptyString(
	value: unknown,
	field: string,
	context: Record<string, unknown> = {},
): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		return invalid(`Interaction field '${field}' must be a non-empty string.`, {
			...context,
			field,
		});
	}
	return value.trim();
}

/** Preserve user-controlled semantic text exactly, including whitespace. */
function textString(
	value: unknown,
	field: string,
	context: Record<string, unknown> = {},
): string {
	if (typeof value !== "string") {
		return invalid(`Interaction field '${field}' must be a string.`, {
			...context,
			field,
		});
	}
	return value;
}

function nullableString(
	value: unknown,
	field: string,
	context: Record<string, unknown> = {},
): string | null {
	return value === null ? null : nonEmptyString(value, field, context);
}

function finiteNumber(
	value: unknown,
	field: string,
	context: Record<string, unknown> = {},
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return invalid(`Interaction field '${field}' must be a finite number.`, {
			...context,
			field,
		});
	}
	return value;
}

function nonNegativeInteger(
	value: unknown,
	field: string,
	context: Record<string, unknown> = {},
): number {
	const number = finiteNumber(value, field, context);
	if (!Number.isInteger(number) || number < 0) {
		return invalid(
			`Interaction field '${field}' must be a non-negative integer.`,
			{ ...context, field },
		);
	}
	return number;
}

function isoTimestamp(
	value: unknown,
	field: string,
	context: Record<string, unknown> = {},
): string {
	const timestamp = nonEmptyString(value, field, context);
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(
			timestamp,
		);
	if (!match) {
		return invalid(
			`Interaction field '${field}' must be an ISO timestamp with a timezone.`,
			{ ...context, field },
		);
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
	const parsed = Date.parse(timestamp);
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
		return invalid(
			`Interaction field '${field}' must be a valid ISO timestamp.`,
			{ ...context, field },
		);
	}
	const date = new Date(parsed);
	if (Number.isNaN(date.getTime())) {
		return invalid(
			`Interaction field '${field}' must be a valid ISO timestamp.`,
			{ ...context, field },
		);
	}
	try {
		return date.toISOString();
	} catch {
		// error-policy:J3 untrusted-input sanitizing: non-representable date fails validation
		return invalid(
			`Interaction field '${field}' must be a valid ISO timestamp.`,
			{ ...context, field },
		);
	}
}

function enumValue<T extends string>(
	value: unknown,
	field: string,
	values: readonly T[],
	context: Record<string, unknown> = {},
): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		return invalid(`Interaction field '${field}' is not supported.`, {
			...context,
			field,
			value,
		});
	}
	return value as T;
}

function enumArray<T extends string>(
	value: unknown,
	field: string,
	values: readonly T[],
	context: Record<string, unknown> = {},
): readonly T[] {
	if (!Array.isArray(value)) {
		return invalid(`Interaction field '${field}' must be an array.`, {
			...context,
			field,
		});
	}
	const normalized = value.map((entry, index) =>
		enumValue(entry, `${field}[${index}]`, values, context),
	);
	return Object.freeze([...new Set(normalized)]);
}

function stringArray(
	value: unknown,
	field: string,
	context: Record<string, unknown> = {},
): readonly string[] {
	if (!Array.isArray(value)) {
		return invalid(`Interaction field '${field}' must be an array.`, {
			...context,
			field,
		});
	}
	const normalized = value.map((entry, index) =>
		nonEmptyString(entry, `${field}[${index}]`, context),
	);
	return Object.freeze([...new Set(normalized)]);
}

function booleanValue(
	value: unknown,
	field: string,
	context: Record<string, unknown> = {},
): boolean {
	if (typeof value !== "boolean") {
		return invalid(`Interaction field '${field}' must be a boolean.`, {
			...context,
			field,
		});
	}
	return value;
}

function sha256Digest(
	value: unknown,
	field: string,
	context: Record<string, unknown> = {},
): string {
	const digest = nonEmptyString(value, field, context).toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(digest)) {
		return invalid(`Interaction field '${field}' must be a SHA-256 digest.`, {
			...context,
			field,
		});
	}
	return digest;
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
	const record = asRecord(value);
	if (!record)
		return invalid("Interaction digest input is not canonical JSON.");
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

function normalizeRect(
	value: unknown,
	field: string,
	context: Record<string, unknown> = {},
): InteractionRect {
	const raw = asRecord(value);
	if (!raw) return invalid(`Interaction field '${field}' must be a rectangle.`);
	const width = finiteNumber(raw.width, `${field}.width`, context);
	const height = finiteNumber(raw.height, `${field}.height`, context);
	if (width < 0 || height < 0) {
		return invalid(
			`Interaction field '${field}' cannot have negative dimensions.`,
		);
	}
	return Object.freeze({
		x: finiteNumber(raw.x, `${field}.x`, context),
		y: finiteNumber(raw.y, `${field}.y`, context),
		width,
		height,
	});
}

function normalizePoint(
	value: unknown,
	field: string,
	context: Record<string, unknown> = {},
): InteractionPoint {
	const raw = asRecord(value);
	if (!raw) return invalid(`Interaction field '${field}' must be a point.`);
	return Object.freeze({
		x: finiteNumber(raw.x, `${field}.x`, context),
		y: finiteNumber(raw.y, `${field}.y`, context),
	});
}

export function normalizeInteractionSurfaceRef(
	value: unknown,
): InteractionSurfaceRef {
	const raw = asRecord(value);
	if (!raw) return invalid("Interaction surface must be an object.");
	const surfaceId = nonEmptyString(raw.surfaceId, "surfaceId");
	const context = { surfaceId };
	return Object.freeze({
		sessionId: nonEmptyString(raw.sessionId, "sessionId", context),
		adapterId: nonEmptyString(raw.adapterId, "adapterId", context),
		surfaceId,
		kind: enumValue(raw.kind, "kind", INTERACTION_SURFACE_KINDS, context),
		generation: nonNegativeInteger(raw.generation, "generation", context),
		parentSurfaceId: nullableString(
			raw.parentSurfaceId,
			"parentSurfaceId",
			context,
		),
	});
}

function validClock(value: number, field = "now"): number {
	if (!Number.isFinite(value) || Number.isNaN(new Date(value).getTime())) {
		return invalid(`Interaction field '${field}' must be a valid timestamp.`, {
			field,
		});
	}
	return value;
}

function normalizeProfileGrant(value: unknown): InteractionProfileGrantRef {
	const raw = asRecord(value);
	if (!raw) return invalid("Interaction profile grant must be an object.");
	const grantId = nonEmptyString(raw.grantId, "profileGrant.grantId");
	const context = { grantId };
	const issuedAt = isoTimestamp(raw.issuedAt, "profileGrant.issuedAt", context);
	const expiresAt = isoTimestamp(
		raw.expiresAt,
		"profileGrant.expiresAt",
		context,
	);
	if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
		return invalid(
			"Interaction profile grant must expire after issuance.",
			context,
		);
	}
	return Object.freeze({
		grantId,
		sessionId: nonEmptyString(raw.sessionId, "profileGrant.sessionId", context),
		ownerId: nonEmptyString(raw.ownerId, "profileGrant.ownerId", context),
		adapterId: nonEmptyString(raw.adapterId, "profileGrant.adapterId", context),
		profileHandle: nonEmptyString(
			raw.profileHandle,
			"profileGrant.profileHandle",
			context,
		),
		issuedAt,
		expiresAt,
	});
}

export interface NormalizeInteractionSessionOptions {
	capabilities: InteractionCapabilitySet;
}

/** Normalize stored or transported session state without requiring executability. */
export function normalizeInteractionSession(
	value: unknown,
	options: NormalizeInteractionSessionOptions,
): InteractionSession {
	const raw = asRecord(value);
	if (!raw) return invalid("Interaction session must be an object.");
	if (raw.contractVersion !== INTERACTION_CONTRACT_VERSION) {
		return invalid("Unsupported interaction contract version.", {
			contractVersion: raw.contractVersion,
		});
	}
	const capabilities = normalizeInteractionCapabilitySet(options.capabilities);
	const sessionId = nonEmptyString(raw.sessionId, "sessionId");
	const ownerId = nonEmptyString(raw.ownerId, "ownerId", { sessionId });
	const adapterId = nonEmptyString(raw.adapterId, "adapterId", { sessionId });
	if (adapterId !== capabilities.adapterId) {
		return invalid(
			"Interaction session adapter is not the advertised adapter.",
			{
				sessionId,
				adapterId,
				capabilityAdapterId: capabilities.adapterId,
			},
		);
	}
	const generation = nonNegativeInteger(raw.generation, "generation", {
		sessionId,
	});
	const state = enumValue(raw.state, "state", INTERACTION_SESSION_STATES, {
		sessionId,
	});
	const profileMode = enumValue(
		raw.profileMode,
		"profileMode",
		INTERACTION_PROFILE_MODES,
		{ sessionId },
	);
	if (!capabilities.profileAccess.modes.includes(profileMode)) {
		return invalid("Interaction session profile mode was not advertised.", {
			sessionId,
			profileMode,
		});
	}
	const createdAt = isoTimestamp(raw.createdAt, "createdAt", { sessionId });
	const updatedAt = isoTimestamp(raw.updatedAt, "updatedAt", { sessionId });
	if (Date.parse(updatedAt) < Date.parse(createdAt)) {
		return invalid("Interaction session was updated before creation.", {
			sessionId,
		});
	}
	const expiresAt =
		raw.expiresAt === null
			? null
			: isoTimestamp(raw.expiresAt, "expiresAt", { sessionId });
	if (
		expiresAt &&
		(Date.parse(expiresAt) <= Date.parse(createdAt) ||
			Date.parse(expiresAt) < Date.parse(updatedAt))
	) {
		return invalid("Interaction session expiry precedes its lifecycle.", {
			sessionId,
			expiresAt,
		});
	}
	if (!Array.isArray(raw.surfaces) || raw.surfaces.length === 0) {
		return invalid("Interaction session requires at least one surface.", {
			sessionId,
		});
	}
	const seenSurfaceIds = new Set<string>();
	const surfaces = raw.surfaces.map((entry) => {
		const surface = normalizeInteractionSurfaceRef(entry);
		if (
			surface.sessionId !== sessionId ||
			surface.adapterId !== adapterId ||
			surface.generation !== generation
		) {
			return invalid(
				"Interaction session contains a foreign or stale surface.",
				{
					sessionId,
					surfaceId: surface.surfaceId,
				},
			);
		}
		if (!capabilities.surfaceKinds.includes(surface.kind)) {
			return invalid("Interaction surface kind was not advertised.", {
				sessionId,
				surfaceId: surface.surfaceId,
				kind: surface.kind,
			});
		}
		if (seenSurfaceIds.has(surface.surfaceId)) {
			return invalid("Interaction session surface IDs must be unique.", {
				sessionId,
				surfaceId: surface.surfaceId,
			});
		}
		seenSurfaceIds.add(surface.surfaceId);
		return surface;
	});
	for (const candidate of surfaces) {
		if (
			candidate.parentSurfaceId !== null &&
			(candidate.parentSurfaceId === candidate.surfaceId ||
				!seenSurfaceIds.has(candidate.parentSurfaceId))
		) {
			return invalid("Interaction surface parent is not in the session.", {
				sessionId,
				surfaceId: candidate.surfaceId,
				parentSurfaceId: candidate.parentSurfaceId,
			});
		}
	}
	const parentBySurfaceId = new Map(
		surfaces.map((candidate) => [
			candidate.surfaceId,
			candidate.parentSurfaceId,
		]),
	);
	for (const candidate of surfaces) {
		const visited = new Set<string>([candidate.surfaceId]);
		let parent = candidate.parentSurfaceId;
		while (parent !== null) {
			if (visited.has(parent)) {
				return invalid("Interaction surface hierarchy contains a cycle.", {
					sessionId,
					surfaceId: candidate.surfaceId,
				});
			}
			visited.add(parent);
			parent = parentBySurfaceId.get(parent) ?? null;
		}
	}
	const profileGrant =
		raw.profileGrant === null ? null : normalizeProfileGrant(raw.profileGrant);
	if (profileMode === "existing_explicit") {
		if (!capabilities.profileAccess.requiresExplicitGrant) {
			return invalid("Existing-profile sessions require explicit grants.", {
				sessionId,
			});
		}
		if (
			!profileGrant ||
			profileGrant.sessionId !== sessionId ||
			profileGrant.ownerId !== ownerId ||
			profileGrant.adapterId !== adapterId ||
			(expiresAt !== null &&
				Date.parse(expiresAt) > Date.parse(profileGrant.expiresAt))
		) {
			return invalid("Existing-profile session grant is missing or invalid.", {
				sessionId,
			});
		}
	} else if (profileGrant) {
		return invalid(
			"Only existing-profile sessions may carry a profile grant.",
			{
				sessionId,
				profileMode,
			},
		);
	}
	return Object.freeze({
		contractVersion: INTERACTION_CONTRACT_VERSION,
		sessionId,
		ownerId,
		adapterId,
		state,
		isolationMode: enumValue(
			raw.isolationMode,
			"isolationMode",
			INTERACTION_ISOLATION_MODES,
			{ sessionId },
		),
		profileMode,
		generation,
		createdAt,
		updatedAt,
		expiresAt,
		profileGrant,
		surfaces: Object.freeze(surfaces),
	});
}

export interface AssertInteractionSessionExecutableOptions
	extends NormalizeInteractionSessionOptions {
	now?: number;
	profileGrantVerifier?: InteractionProfileGrantVerifier;
}

/** Require a normalized session to be live and authorized for execution. */
export function assertInteractionSessionExecutable(
	value: unknown,
	options: AssertInteractionSessionExecutableOptions,
): InteractionSession {
	const session = normalizeInteractionSession(value, options);
	const now = validClock(options.now ?? Date.now());
	if (session.state !== "ready" && session.state !== "running") {
		return invalid("Interaction session is not executable.", {
			sessionId: session.sessionId,
			state: session.state,
		});
	}
	if (session.expiresAt && Date.parse(session.expiresAt) <= now) {
		return invalid("Interaction session is expired.", {
			sessionId: session.sessionId,
			expiresAt: session.expiresAt,
		});
	}
	if (session.profileMode === "existing_explicit") {
		const grant = session.profileGrant;
		if (
			!grant ||
			Date.parse(grant.issuedAt) > now ||
			Date.parse(grant.expiresAt) <= now ||
			!options.profileGrantVerifier?.verify(grant, {
				sessionId: session.sessionId,
				ownerId: session.ownerId,
				adapterId: session.adapterId,
				now,
			})
		) {
			return invalid(
				"Existing-profile session grant is not current and host-verified.",
				{ sessionId: session.sessionId, grantId: grant?.grantId },
			);
		}
	}
	return session;
}

export function normalizeInteractionCapabilitySet(
	value: unknown,
): InteractionCapabilitySet {
	const raw = asRecord(value);
	if (!raw) return invalid("Interaction capability set must be an object.");
	if (raw.contractVersion !== INTERACTION_CONTRACT_VERSION) {
		return invalid("Unsupported interaction contract version.", {
			contractVersion: raw.contractVersion,
		});
	}
	const adapterId = nonEmptyString(raw.adapterId, "adapterId");
	const context = { adapterId };
	const background = asRecord(raw.background);
	const profileAccess = asRecord(raw.profileAccess);
	const concurrency = asRecord(raw.concurrency);
	if (!background || !profileAccess || !concurrency) {
		return invalid(
			"Interaction capabilities require background, profileAccess, and concurrency objects.",
			context,
		);
	}
	const maxSessions =
		concurrency.maxSessions === null
			? null
			: nonNegativeInteger(
					concurrency.maxSessions,
					"concurrency.maxSessions",
					context,
				);
	if (maxSessions === 0) {
		return invalid(
			"Interaction maxSessions must be positive or null.",
			context,
		);
	}
	if (typeof profileAccess.requiresExplicitGrant !== "boolean") {
		return invalid(
			"Interaction profileAccess.requiresExplicitGrant must be a boolean.",
			context,
		);
	}
	if (!Array.isArray(raw.limitations)) {
		return invalid("Interaction limitations must be an array.", context);
	}
	const controlPlanes = enumArray(
		raw.controlPlanes,
		"controlPlanes",
		INTERACTION_CONTROL_PLANES,
		context,
	);
	const surfaceKinds = enumArray(
		raw.surfaceKinds,
		"surfaceKinds",
		INTERACTION_SURFACE_KINDS,
		context,
	);
	const observationChannels = enumArray(
		raw.observationChannels,
		"observationChannels",
		INTERACTION_OBSERVATION_CHANNELS,
		context,
	);
	const actionKinds = enumArray(
		raw.actionKinds,
		"actionKinds",
		INTERACTION_ACTION_KINDS,
		context,
	);
	const requiresForeground = enumArray(
		background.requiresForeground,
		"background.requiresForeground",
		INTERACTION_ACTION_KINDS,
		context,
	);
	const profileModes = enumArray(
		profileAccess.modes,
		"profileAccess.modes",
		INTERACTION_PROFILE_MODES,
		context,
	);
	if (
		controlPlanes.length === 0 ||
		surfaceKinds.length === 0 ||
		observationChannels.length === 0 ||
		actionKinds.length === 0
	) {
		return invalid(
			"Interaction adapters must advertise at least one plane, surface, observation channel, and action.",
			context,
		);
	}
	const unadvertisedForegroundAction = requiresForeground.find(
		(actionKind) => !actionKinds.includes(actionKind),
	);
	if (unadvertisedForegroundAction) {
		return invalid(
			"Interaction foreground requirements must reference advertised actions.",
			{ ...context, actionKind: unadvertisedForegroundAction },
		);
	}
	if (
		profileModes.includes("existing_explicit") &&
		profileAccess.requiresExplicitGrant !== true
	) {
		return invalid(
			"Existing-profile access must require an explicit grant.",
			context,
		);
	}
	const limitations = raw.limitations.map((entry, index) => {
		const limitation = asRecord(entry);
		if (!limitation) {
			return invalid("Interaction limitation must be an object.", {
				...context,
				index,
			});
		}
		return Object.freeze({
			code: nonEmptyString(limitation.code, `limitations[${index}].code`),
			description: nonEmptyString(
				limitation.description,
				`limitations[${index}].description`,
			),
			actionKinds: enumArray(
				limitation.actionKinds,
				`limitations[${index}].actionKinds`,
				INTERACTION_ACTION_KINDS,
			),
			surfaceKinds: enumArray(
				limitation.surfaceKinds,
				`limitations[${index}].surfaceKinds`,
				INTERACTION_SURFACE_KINDS,
			),
		});
	});
	return Object.freeze({
		contractVersion: INTERACTION_CONTRACT_VERSION,
		adapterId,
		controlPlanes,
		surfaceKinds,
		observationChannels,
		actionKinds,
		background: Object.freeze({
			mode: enumValue(
				background.mode,
				"background.mode",
				INTERACTION_BACKGROUND_MODES,
				context,
			),
			requiresForeground,
		}),
		profileAccess: Object.freeze({
			modes: profileModes,
			requiresExplicitGrant: profileAccess.requiresExplicitGrant,
		}),
		concurrency: Object.freeze({
			mode: enumValue(
				concurrency.mode,
				"concurrency.mode",
				INTERACTION_CONCURRENCY_MODES,
				context,
			),
			maxSessions,
			sharedResources: enumArray(
				concurrency.sharedResources,
				"concurrency.sharedResources",
				INTERACTION_LEASE_RESOURCE_KINDS,
				context,
			),
		}),
		limitations: Object.freeze(limitations),
	});
}

function normalizeConfirmationGrant(
	value: unknown,
): InteractionConfirmationGrant {
	const raw = asRecord(value);
	if (!raw) return invalid("Interaction confirmation grant must be an object.");
	const confirmationId = nonEmptyString(
		raw.confirmationId,
		"confirmationGrant.confirmationId",
	);
	const context = { confirmationId };
	const confirmedAt = isoTimestamp(
		raw.confirmedAt,
		"confirmationGrant.confirmedAt",
		context,
	);
	const expiresAt = isoTimestamp(
		raw.expiresAt,
		"confirmationGrant.expiresAt",
		context,
	);
	if (Date.parse(expiresAt) <= Date.parse(confirmedAt)) {
		return invalid(
			"Interaction confirmation grant must expire after approval.",
			{
				confirmationId,
			},
		);
	}
	return Object.freeze({
		confirmationId,
		actionId: nonEmptyString(
			raw.actionId,
			"confirmationGrant.actionId",
			context,
		),
		actionDigest: sha256Digest(
			raw.actionDigest,
			"confirmationGrant.actionDigest",
			context,
		),
		confirmedAt,
		expiresAt,
	});
}

function nullablePoint(value: unknown, field: string): InteractionPoint | null {
	return value === null ? null : normalizePoint(value, field);
}

function normalizeActionPayload(
	kind: InteractionActionKind,
	value: unknown,
): InteractionAction["payload"] {
	const raw = asRecord(value);
	if (!raw)
		return invalid("Interaction action payload must be an object.", { kind });
	switch (kind) {
		case "observe":
		case "close":
		case "back":
		case "forward":
		case "reload":
		case "close_tab":
		case "get_clipboard":
		case "stop_capture":
			return Object.freeze({});
		case "click":
		case "double_click":
		case "context_click":
		case "hover": {
			const elementId = nullableString(raw.elementId, "payload.elementId", {
				kind,
			});
			const point = nullablePoint(raw.point, "payload.point");
			if (elementId === null && point === null) {
				return invalid(
					"Interaction pointer action requires an explicit target.",
					{
						kind,
					},
				);
			}
			return Object.freeze({ elementId, point });
		}
		case "drag": {
			const fromElementId = nullableString(
				raw.fromElementId,
				"payload.fromElementId",
				{ kind },
			);
			const toElementId = nullableString(
				raw.toElementId,
				"payload.toElementId",
				{ kind },
			);
			const from = nullablePoint(raw.from, "payload.from");
			const to = nullablePoint(raw.to, "payload.to");
			if (
				(fromElementId === null && from === null) ||
				(toElementId === null && to === null)
			) {
				return invalid(
					"Interaction drag requires explicit source and destination targets.",
					{ kind },
				);
			}
			return Object.freeze({ fromElementId, toElementId, from, to });
		}
		case "scroll":
			return Object.freeze({
				deltaX: finiteNumber(raw.deltaX, "payload.deltaX", { kind }),
				deltaY: finiteNumber(raw.deltaY, "payload.deltaY", { kind }),
				elementId: nullableString(raw.elementId, "payload.elementId", { kind }),
			});
		case "type_text":
		case "set_value":
			return Object.freeze({
				text: textString(raw.text, "payload.text", { kind }),
				elementId: nullableString(raw.elementId, "payload.elementId", { kind }),
				sensitive: booleanValue(raw.sensitive, "payload.sensitive", { kind }),
			});
		case "press_key":
			return Object.freeze({
				key: nonEmptyString(raw.key, "payload.key", { kind }),
			});
		case "select":
			return Object.freeze({
				elementId: nonEmptyString(raw.elementId, "payload.elementId", { kind }),
				value: textString(raw.value, "payload.value", { kind }),
			});
		case "focus":
			return Object.freeze({
				elementId: nullableString(raw.elementId, "payload.elementId", { kind }),
			});
		case "navigate":
		case "open":
		case "create_tab":
			return Object.freeze({
				url: nonEmptyString(raw.url, "payload.url", { kind }),
			});
		case "evaluate":
			return Object.freeze({
				expression: textString(raw.expression, "payload.expression", {
					kind,
				}),
			});
		case "upload": {
			const fileHandles = stringArray(raw.fileHandles, "payload.fileHandles", {
				kind,
			});
			if (fileHandles.length === 0) {
				return invalid(
					"Interaction upload requires at least one file handle.",
					{
						kind,
					},
				);
			}
			return Object.freeze({
				elementId: nonEmptyString(raw.elementId, "payload.elementId", { kind }),
				fileHandles,
			});
		}
		case "download": {
			const elementId = nullableString(raw.elementId, "payload.elementId", {
				kind,
			});
			const url = nullableString(raw.url, "payload.url", { kind });
			if (elementId === null && url === null) {
				return invalid("Interaction download requires an explicit target.", {
					kind,
				});
			}
			return Object.freeze({ elementId, url });
		}
		case "wait": {
			const timeoutMs = nonNegativeInteger(raw.timeoutMs, "payload.timeoutMs", {
				kind,
			});
			if (timeoutMs === 0)
				return invalid("Interaction wait timeout must be positive.");
			return Object.freeze({
				condition: nonEmptyString(raw.condition, "payload.condition", { kind }),
				timeoutMs,
			});
		}
		case "switch_tab":
			return Object.freeze({
				tabId: nonEmptyString(raw.tabId, "payload.tabId", { kind }),
			});
		case "move_window":
			return Object.freeze({
				point: normalizePoint(raw.point, "payload.point"),
			});
		case "resize_window": {
			const width = finiteNumber(raw.width, "payload.width", { kind });
			const height = finiteNumber(raw.height, "payload.height", { kind });
			if (width <= 0 || height <= 0) {
				return invalid("Interaction window dimensions must be positive.", {
					kind,
				});
			}
			return Object.freeze({ width, height });
		}
		case "launch_app":
		case "quit_app":
			return Object.freeze({
				applicationId: nonEmptyString(
					raw.applicationId,
					"payload.applicationId",
					{ kind },
				),
			});
		case "set_clipboard":
			return Object.freeze({
				text: textString(raw.text, "payload.text", { kind }),
				sensitive: booleanValue(raw.sensitive, "payload.sensitive", { kind }),
			});
		case "request_permission":
			return Object.freeze({
				permission: nonEmptyString(raw.permission, "payload.permission", {
					kind,
				}),
			});
		case "start_capture": {
			const framesPerSecond = finiteNumber(
				raw.framesPerSecond,
				"payload.framesPerSecond",
				{ kind },
			);
			if (framesPerSecond <= 0 || framesPerSecond > 240) {
				return invalid("Interaction capture frame rate must be in (0, 240].", {
					kind,
				});
			}
			return Object.freeze({
				framesPerSecond,
				includeAudio: booleanValue(raw.includeAudio, "payload.includeAudio", {
					kind,
				}),
			});
		}
	}
}

export interface NormalizeInteractionActionOptions {
	session: InteractionSession;
	now?: number;
	confirmationGrantVerifier?: InteractionConfirmationGrantVerifier;
}

/** Normalize one exact action and bind it to a current session surface. */
export function normalizeInteractionAction(
	value: unknown,
	options: NormalizeInteractionActionOptions,
): InteractionAction {
	const raw = asRecord(value);
	if (!raw) return invalid("Interaction action must be an object.");
	if (raw.contractVersion !== INTERACTION_CONTRACT_VERSION) {
		return invalid("Unsupported interaction contract version.", {
			contractVersion: raw.contractVersion,
		});
	}
	const actionId = nonEmptyString(raw.actionId, "actionId");
	const context = { actionId };
	const sessionId = nonEmptyString(raw.sessionId, "sessionId", context);
	const adapterId = nonEmptyString(raw.adapterId, "adapterId", context);
	if (
		sessionId !== options.session.sessionId ||
		adapterId !== options.session.adapterId
	) {
		return invalid(
			"Interaction action belongs to another session or adapter.",
			{
				...context,
				sessionId,
				adapterId,
			},
		);
	}
	const surface = normalizeInteractionSurfaceRef(raw.surface);
	assertInteractionSurfaceCurrent(options.session, surface);
	const observationId = nullableString(
		raw.observationId,
		"observationId",
		context,
	);
	const observationSequence =
		raw.observationSequence === null
			? null
			: nonNegativeInteger(
					raw.observationSequence,
					"observationSequence",
					context,
				);
	if ((observationId === null) !== (observationSequence === null)) {
		return invalid(
			"Interaction observation ID and sequence must both be present or absent.",
			context,
		);
	}
	const kind = enumValue(raw.kind, "kind", INTERACTION_ACTION_KINDS, context);
	const action = Object.freeze({
		contractVersion: INTERACTION_CONTRACT_VERSION,
		actionId,
		sessionId,
		adapterId,
		surface,
		kind,
		payload: normalizeActionPayload(kind, raw.payload),
		observationId,
		observationSequence,
		requestedAt: isoTimestamp(raw.requestedAt, "requestedAt", context),
		confirmationGrant:
			raw.confirmationGrant === null
				? null
				: normalizeConfirmationGrant(raw.confirmationGrant),
		leaseIds: stringArray(raw.leaseIds, "leaseIds", context),
	}) as InteractionAction;
	const normalizationNow = validClock(options.now ?? Date.now());
	if (Date.parse(action.requestedAt) > normalizationNow) {
		return invalid("Interaction action request is future-dated.", {
			actionId: action.actionId,
			requestedAt: action.requestedAt,
		});
	}
	if (action.confirmationGrant) {
		assertInteractionConfirmationCurrent(
			action.confirmationGrant,
			action,
			normalizationNow,
		);
		if (
			!options.confirmationGrantVerifier?.verify(
				action.confirmationGrant,
				action,
				normalizationNow,
			)
		) {
			throw new ElizaError(
				"Interaction confirmation grant is missing, stale, or already consumed.",
				{
					code: "STALE_INTERACTION_CONFIRMATION",
					context: { actionId: action.actionId },
					severity: "ephemeral",
				},
			);
		}
	}
	return action;
}

/** Digest the immutable semantic action, excluding ephemeral grants and leases. */
export function computeInteractionActionDigest(
	action: InteractionAction,
): string {
	const canonical = stableJson({
		contractVersion: action.contractVersion,
		actionId: action.actionId,
		sessionId: action.sessionId,
		adapterId: action.adapterId,
		surface: action.surface,
		kind: action.kind,
		payload: action.payload,
		observationId: action.observationId,
		observationSequence: action.observationSequence,
		requestedAt: action.requestedAt,
	});
	return bytesToHex(
		sha256(
			new TextEncoder().encode(`elizaos:interaction-action:v2\n${canonical}`),
		),
	);
}

/** Verify that a preview or grant authorizes this exact, unmodified action. */
export function assertInteractionConfirmationCurrent(
	confirmation: InteractionConfirmationPreview | InteractionConfirmationGrant,
	action: InteractionAction,
	now: number = Date.now(),
): void {
	validClock(now);
	if (
		confirmation.actionId !== action.actionId ||
		confirmation.actionDigest !== computeInteractionActionDigest(action)
	) {
		throw new ElizaError(
			"Interaction confirmation does not authorize this exact action.",
			{
				code: "INTERACTION_CONFIRMATION_MISMATCH",
				context: {
					actionId: action.actionId,
					confirmationActionId: confirmation.actionId,
				},
				severity: "fatal",
			},
		);
	}
	if (Date.parse(confirmation.expiresAt) <= now) {
		throw new ElizaError("Interaction confirmation is expired.", {
			code: "STALE_INTERACTION_CONFIRMATION",
			context: { actionId: action.actionId, expiresAt: confirmation.expiresAt },
			severity: "ephemeral",
		});
	}
	if (
		"confirmedAt" in confirmation &&
		(Date.parse(confirmation.confirmedAt) > now ||
			Date.parse(confirmation.confirmedAt) < Date.parse(action.requestedAt))
	) {
		throw new ElizaError(
			"Interaction confirmation grant chronology is invalid.",
			{
				code: "STALE_INTERACTION_CONFIRMATION",
				context: {
					actionId: action.actionId,
					confirmedAt: confirmation.confirmedAt,
				},
				severity: "ephemeral",
			},
		);
	}
}

interface StoredInteractionConfirmation {
	preview: InteractionConfirmationPreview;
	actionDigest: string;
}

/**
 * In-memory confirmation issuer with consume-once replay protection. Distributed
 * hosts persist the same preview/grant states behind this verifier contract.
 */
export class InteractionConfirmationCoordinator
	implements
		InteractionConfirmationGrantVerifier,
		InteractionConfirmationGrantConsumer
{
	private readonly pending = new Map<string, StoredInteractionConfirmation>();
	private readonly issued = new Map<string, InteractionConfirmationGrant>();

	register(
		previewValue: unknown,
		action: InteractionAction,
		now: number = Date.now(),
	): InteractionConfirmationPreview {
		const preview = normalizeInteractionConfirmationPreview(previewValue);
		const trustedNow = validClock(now);
		assertInteractionConfirmationCurrent(preview, action, trustedNow);
		if (Date.parse(preview.requestedAt) > trustedNow) {
			return invalid("Interaction confirmation preview is future-dated.", {
				confirmationId: preview.confirmationId,
			});
		}
		if (
			this.pending.has(preview.confirmationId) ||
			this.issued.has(preview.confirmationId)
		) {
			return invalid("Interaction confirmation ID is already registered.", {
				confirmationId: preview.confirmationId,
			});
		}
		this.pending.set(preview.confirmationId, {
			preview,
			actionDigest: computeInteractionActionDigest(action),
		});
		return preview;
	}

	issue(
		confirmationId: string,
		action: InteractionAction,
		confirmedAt: string,
		now: number = Date.now(),
	): InteractionConfirmationGrant {
		const trustedNow = validClock(now);
		const id = nonEmptyString(confirmationId, "confirmationId");
		const stored = this.pending.get(id);
		if (!stored) {
			return invalid("Interaction confirmation preview is not pending.", {
				confirmationId: id,
			});
		}
		assertInteractionConfirmationCurrent(stored.preview, action, trustedNow);
		const normalizedConfirmedAt = isoTimestamp(confirmedAt, "confirmedAt", {
			confirmationId: id,
		});
		if (
			Date.parse(normalizedConfirmedAt) <
				Date.parse(stored.preview.requestedAt) ||
			Date.parse(normalizedConfirmedAt) > trustedNow
		) {
			return invalid("Interaction confirmation approval time is invalid.", {
				confirmationId: id,
			});
		}
		const grant = Object.freeze({
			confirmationId: id,
			actionId: action.actionId,
			actionDigest: stored.actionDigest,
			confirmedAt: normalizedConfirmedAt,
			expiresAt: stored.preview.expiresAt,
		});
		this.pending.delete(id);
		this.issued.set(id, grant);
		return grant;
	}

	verify(
		grant: InteractionConfirmationGrant,
		action: InteractionAction,
		now: number,
	): boolean {
		const issued = this.issued.get(grant.confirmationId);
		return (
			issued !== undefined &&
			issued.confirmationId === grant.confirmationId &&
			issued.actionId === grant.actionId &&
			issued.actionDigest === grant.actionDigest &&
			issued.confirmedAt === grant.confirmedAt &&
			issued.expiresAt === grant.expiresAt &&
			issued.actionId === action.actionId &&
			issued.actionDigest === computeInteractionActionDigest(action) &&
			Date.parse(issued.expiresAt) > validClock(now)
		);
	}

	async consume(
		grant: InteractionConfirmationGrant,
		action: InteractionAction,
		now: number = Date.now(),
	): Promise<void> {
		if (!this.verify(grant, action, now)) {
			throw new ElizaError(
				"Interaction confirmation grant is missing, stale, or already consumed.",
				{
					code: "STALE_INTERACTION_CONFIRMATION",
					context: {
						actionId: action.actionId,
						confirmationId: grant.confirmationId,
					},
					severity: "ephemeral",
				},
			);
		}
		this.issued.delete(grant.confirmationId);
	}
}

function normalizeArtifact(
	value: unknown,
	index: number,
): InteractionArtifactRef {
	const raw = asRecord(value);
	if (!raw)
		return invalid("Interaction artifact must be an object.", { index });
	const kinds: readonly InteractionArtifactRef["kind"][] = [
		"semantic_tree",
		"screenshot",
		"video",
		"event_log",
		"ocr",
	];
	const sha256 = nonEmptyString(raw.sha256, `artifacts[${index}].sha256`);
	if (!/^[0-9a-f]{64}$/i.test(sha256)) {
		return invalid(
			"Interaction artifact sha256 must be a 64-character hex digest.",
			{
				index,
			},
		);
	}
	return Object.freeze({
		kind: enumValue(raw.kind, `artifacts[${index}].kind`, kinds),
		uri: nonEmptyString(raw.uri, `artifacts[${index}].uri`),
		sha256: sha256.toLowerCase(),
		mimeType: nullableString(raw.mimeType, `artifacts[${index}].mimeType`),
		width:
			raw.width === null
				? null
				: nonNegativeInteger(raw.width, `artifacts[${index}].width`),
		height:
			raw.height === null
				? null
				: nonNegativeInteger(raw.height, `artifacts[${index}].height`),
	});
}

function normalizeRedaction(
	value: unknown,
	index: number,
): InteractionRedaction {
	const raw = asRecord(value);
	if (!raw)
		return invalid("Interaction redaction must be an object.", { index });
	const kinds: readonly InteractionRedaction["kind"][] = [
		"secure_field",
		"policy_region",
		"credential",
		"personal_data",
	];
	return Object.freeze({
		kind: enumValue(raw.kind, `redactions[${index}].kind`, kinds),
		bounds:
			raw.bounds === null
				? null
				: normalizeRect(raw.bounds, `redactions[${index}].bounds`),
		reason: nonEmptyString(raw.reason, `redactions[${index}].reason`),
	});
}

interface TraceIdentity {
	sessionId: string;
	adapterId: string;
	surfaceId?: string | null;
	actionId?: string | null;
	observationId?: string | null;
}

function normalizeTraceEvents(
	value: unknown,
	identity: TraceIdentity,
): readonly InteractionTraceEvent[] {
	if (!Array.isArray(value)) {
		return invalid("Interaction traceEvents must be an array.");
	}
	const eventIds = new Set<string>();
	let previousSequence = -1;
	return Object.freeze(
		value.map((entry, index) => {
			const raw = asRecord(entry);
			if (!raw)
				return invalid("Interaction trace event must be an object.", { index });
			const eventId = nonEmptyString(
				raw.eventId,
				`traceEvents[${index}].eventId`,
			);
			if (eventIds.has(eventId)) {
				return invalid("Interaction trace event IDs must be unique.", {
					eventId,
				});
			}
			eventIds.add(eventId);
			const sequence = nonNegativeInteger(
				raw.sequence,
				`traceEvents[${index}].sequence`,
			);
			if (sequence <= previousSequence) {
				return invalid("Interaction trace event sequence must increase.", {
					eventId,
					sequence,
				});
			}
			previousSequence = sequence;
			const sessionId = nonEmptyString(
				raw.sessionId,
				`traceEvents[${index}].sessionId`,
			);
			const adapterId = nonEmptyString(
				raw.adapterId,
				`traceEvents[${index}].adapterId`,
			);
			const surfaceId = nullableString(
				raw.surfaceId,
				`traceEvents[${index}].surfaceId`,
			);
			const actionId = nullableString(
				raw.actionId,
				`traceEvents[${index}].actionId`,
			);
			const observationId = nullableString(
				raw.observationId,
				`traceEvents[${index}].observationId`,
			);
			if (
				sessionId !== identity.sessionId ||
				adapterId !== identity.adapterId ||
				(identity.surfaceId !== undefined &&
					surfaceId !== identity.surfaceId) ||
				(identity.actionId !== undefined && actionId !== identity.actionId) ||
				(identity.observationId !== undefined &&
					observationId !== identity.observationId)
			) {
				return invalid("Interaction trace event identity mismatch.", {
					eventId,
				});
			}
			if (!Array.isArray(raw.attributes)) {
				return invalid("Interaction trace attributes must be an array.", {
					eventId,
				});
			}
			const attributes = raw.attributes.map((attribute, attributeIndex) => {
				const item = asRecord(attribute);
				if (!item) {
					return invalid("Interaction trace attribute must be an object.", {
						eventId,
						attributeIndex,
					});
				}
				const classification = enumValue(
					item.classification,
					`traceEvents[${index}].attributes[${attributeIndex}].classification`,
					["public", "personal_data", "credential", "secure_field"] as const,
				);
				const name = nonEmptyString(
					item.name,
					`traceEvents[${index}].attributes[${attributeIndex}].name`,
				);
				if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(name)) {
					return invalid(
						"Interaction trace attribute name is not a safe key.",
						{
							eventId,
							name,
						},
					);
				}
				if (classification === "public") {
					if (
						item.value !== null &&
						typeof item.value !== "string" &&
						typeof item.value !== "number" &&
						typeof item.value !== "boolean"
					) {
						return invalid("Public trace attribute has an invalid value.", {
							eventId,
							name,
						});
					}
					if (typeof item.value === "number" && !Number.isFinite(item.value)) {
						return invalid("Public trace attribute number must be finite.", {
							eventId,
							name,
						});
					}
					return Object.freeze({
						classification,
						name,
						value: item.value as string | number | boolean | null,
						opaqueToken: null,
						reason: null,
					});
				}
				if (item.value !== null) {
					return invalid(
						"Sensitive trace attributes cannot contain raw values.",
						{
							eventId,
							name,
						},
					);
				}
				return Object.freeze({
					classification,
					name,
					value: null,
					opaqueToken:
						item.opaqueToken === null
							? null
							: nonEmptyString(
									item.opaqueToken,
									`traceEvents[${index}].attributes[${attributeIndex}].opaqueToken`,
								),
					reason: enumValue(
						item.reason,
						`traceEvents[${index}].attributes[${attributeIndex}].reason`,
						INTERACTION_TRACE_REDACTION_REASONS,
					),
				});
			});
			return Object.freeze({
				eventId,
				sessionId,
				adapterId,
				surfaceId,
				actionId,
				observationId,
				sequence,
				occurredAt: isoTimestamp(
					raw.occurredAt,
					`traceEvents[${index}].occurredAt`,
				),
				kind: enumValue(
					raw.kind,
					`traceEvents[${index}].kind`,
					INTERACTION_TRACE_EVENT_KINDS,
				),
				status:
					raw.status === null
						? null
						: enumValue(
								raw.status,
								`traceEvents[${index}].status`,
								INTERACTION_OUTCOME_STATUSES,
							),
				attributes: Object.freeze(attributes),
			});
		}),
	);
}

export interface NormalizeInteractionObservationOptions {
	actionId?: string | null;
}

export function normalizeInteractionObservation(
	value: unknown,
	options: NormalizeInteractionObservationOptions = {},
): InteractionObservation {
	const raw = asRecord(value);
	if (!raw) return invalid("Interaction observation must be an object.");
	if (raw.contractVersion !== INTERACTION_CONTRACT_VERSION) {
		return invalid("Unsupported interaction contract version.", {
			contractVersion: raw.contractVersion,
		});
	}
	const observationId = nonEmptyString(raw.observationId, "observationId");
	const context = { observationId };
	if (!Array.isArray(raw.artifacts) || !Array.isArray(raw.redactions)) {
		return invalid(
			"Interaction observation artifacts and redactions must be arrays.",
			context,
		);
	}
	const surface = normalizeInteractionSurfaceRef(raw.surface);
	const sessionId = nonEmptyString(raw.sessionId, "sessionId", context);
	const adapterId = nonEmptyString(raw.adapterId, "adapterId", context);
	if (surface.sessionId !== sessionId || surface.adapterId !== adapterId) {
		return invalid(
			"Interaction observation surface does not belong to its session and adapter.",
			context,
		);
	}
	const channels = enumArray(
		raw.channels,
		"channels",
		INTERACTION_OBSERVATION_CHANNELS,
		context,
	);
	if (channels.length === 0) {
		return invalid(
			"Interaction observation requires at least one channel.",
			context,
		);
	}
	const artifacts = Object.freeze(
		raw.artifacts.map((entry, index) => normalizeArtifact(entry, index)),
	);
	const artifactWithoutChannel = artifacts.find((artifact) => {
		switch (artifact.kind) {
			case "screenshot":
			case "video":
			case "ocr":
				return !channels.includes(artifact.kind);
			case "event_log":
				return !channels.includes("browser_events");
			case "semantic_tree":
				return !channels.some((channel) =>
					["dom", "browser_accessibility", "os_accessibility"].includes(
						channel,
					),
				);
			default:
				return false;
		}
	});
	if (artifactWithoutChannel) {
		return invalid(
			"Interaction artifact lacks its declared observation channel.",
			{
				...context,
				artifactKind: artifactWithoutChannel.kind,
			},
		);
	}
	return Object.freeze({
		contractVersion: INTERACTION_CONTRACT_VERSION,
		observationId,
		sessionId,
		adapterId,
		surface,
		sequence: nonNegativeInteger(raw.sequence, "sequence", context),
		observedAt: isoTimestamp(raw.observedAt, "observedAt", context),
		channels,
		artifacts,
		viewport:
			raw.viewport === null ? null : normalizeRect(raw.viewport, "viewport"),
		cursor: raw.cursor === null ? null : normalizePoint(raw.cursor, "cursor"),
		redactions: Object.freeze(
			raw.redactions.map((entry, index) => normalizeRedaction(entry, index)),
		),
		traceEvents: normalizeTraceEvents(raw.traceEvents, {
			sessionId,
			adapterId,
			surfaceId: surface.surfaceId,
			observationId,
			actionId: options.actionId,
		}),
	});
}

export function normalizeInteractionConfirmationPreview(
	value: unknown,
): InteractionConfirmationPreview {
	const raw = asRecord(value);
	if (!raw) return invalid("Interaction confirmation must be an object.");
	const confirmationId = nonEmptyString(raw.confirmationId, "confirmationId");
	const context = { confirmationId };
	const requestedAt = isoTimestamp(raw.requestedAt, "requestedAt", context);
	const expiresAt = isoTimestamp(raw.expiresAt, "expiresAt", context);
	if (Date.parse(expiresAt) <= Date.parse(requestedAt)) {
		return invalid(
			"Interaction confirmation must expire after it is requested.",
			context,
		);
	}
	return Object.freeze({
		confirmationId,
		actionId: nonEmptyString(raw.actionId, "actionId", context),
		taxonomy: nonEmptyString(raw.taxonomy, "taxonomy", context),
		origin: nullableString(raw.origin, "origin", context),
		destination: nullableString(raw.destination, "destination", context),
		disclosures: stringArray(raw.disclosures, "disclosures", context),
		consequence: nonEmptyString(raw.consequence, "consequence", context),
		actionDigest: sha256Digest(raw.actionDigest, "actionDigest", context),
		requestedAt,
		expiresAt,
	});
}

export interface NormalizeInteractionActionResultOptions {
	action: AuthorizedInteractionAction;
	session: InteractionSession;
	capabilities: InteractionCapabilitySet;
	now?: number;
}

export function normalizeInteractionActionResult(
	value: unknown,
	options: NormalizeInteractionActionResultOptions,
): InteractionActionResult {
	const raw = asRecord(value);
	if (!raw) return invalid("Interaction action result must be an object.");
	if (raw.contractVersion !== INTERACTION_CONTRACT_VERSION) {
		return invalid("Unsupported interaction contract version.", {
			contractVersion: raw.contractVersion,
		});
	}
	const actionId = nonEmptyString(raw.actionId, "actionId");
	const context = { actionId };
	if (actionId !== options.action.actionId) {
		return invalid("Interaction result belongs to another action.", {
			actionId,
			expectedActionId: options.action.actionId,
		});
	}
	const status = enumValue(
		raw.status,
		"status",
		INTERACTION_OUTCOME_STATUSES,
		context,
	);
	const startedAt = isoTimestamp(raw.startedAt, "startedAt", context);
	const completedAt = isoTimestamp(raw.completedAt, "completedAt", context);
	const trustedNow = validClock(options.now ?? Date.now());
	if (Date.parse(completedAt) < Date.parse(startedAt)) {
		return invalid("Interaction action completed before it started.", context);
	}
	if (Date.parse(completedAt) > trustedNow) {
		return invalid("Interaction action completion is in the future.", context);
	}
	const normalizedCapabilities = normalizeInteractionCapabilitySet(
		options.capabilities,
	);
	const normalizedSession = normalizeInteractionSession(options.session, {
		capabilities: normalizedCapabilities,
	});
	const normalizedAction = options.action;
	const authorizedAt = normalizedAction[authorizedInteractionAction];
	if (!Number.isSafeInteger(authorizedAt)) {
		return invalid(
			"Interaction result action did not pass pre-dispatch authorization.",
			context,
		);
	}
	if (
		Date.parse(normalizedAction.requestedAt) <
			Date.parse(normalizedSession.createdAt) ||
		Date.parse(normalizedAction.requestedAt) > Date.parse(startedAt) ||
		Date.parse(startedAt) < authorizedAt
	) {
		return invalid("Interaction action chronology is invalid.", context);
	}
	const actionAdvertised = normalizedCapabilities.actionKinds.includes(
		normalizedAction.kind,
	);
	if (!actionAdvertised && status !== "UNSUPPORTED") {
		return invalid(
			"Unadvertised interaction actions must return UNSUPPORTED.",
			{
				...context,
				actionKind: normalizedAction.kind,
			},
		);
	}
	const errorRaw = raw.error === null ? null : asRecord(raw.error);
	if (raw.error !== null && !errorRaw) {
		return invalid(
			"Interaction action error must be an object or null.",
			context,
		);
	}
	const error = errorRaw
		? Object.freeze({
				code: nonEmptyString(errorRaw.code, "error.code", context),
				message: nonEmptyString(errorRaw.message, "error.message", context),
				retryable:
					typeof errorRaw.retryable === "boolean"
						? errorRaw.retryable
						: invalid(
								"Interaction action error.retryable must be a boolean.",
								context,
							),
			})
		: null;
	const confirmation =
		raw.confirmation === null
			? null
			: normalizeInteractionConfirmationPreview(raw.confirmation);
	if (status === "SUCCEEDED" && (error || confirmation)) {
		return invalid(
			"Successful interaction results cannot carry errors or pending confirmations.",
			context,
		);
	}
	if (status === "NEEDS_CONFIRMATION" && !confirmation) {
		return invalid(
			"NEEDS_CONFIRMATION results require a confirmation preview.",
			context,
		);
	}
	if (status === "NEEDS_CONFIRMATION" && error) {
		return invalid(
			"NEEDS_CONFIRMATION results cannot also carry an execution error.",
			context,
		);
	}
	if (status !== "NEEDS_CONFIRMATION" && confirmation) {
		return invalid(
			"Only NEEDS_CONFIRMATION results may carry a confirmation preview.",
			context,
		);
	}
	if (status !== "SUCCEEDED" && status !== "NEEDS_CONFIRMATION" && !error) {
		return invalid(
			`Interaction result '${status}' requires an error.`,
			context,
		);
	}
	if (status === "UNCERTAIN_EFFECT" && error?.retryable !== false) {
		return invalid(
			"UNCERTAIN_EFFECT results must not be automatically retryable.",
			context,
		);
	}
	if (confirmation) {
		if (Date.parse(confirmation.requestedAt) > Date.parse(completedAt)) {
			return invalid(
				"Interaction confirmation was requested after action completion.",
				context,
			);
		}
		assertInteractionConfirmationCurrent(
			confirmation,
			normalizedAction,
			trustedNow,
		);
	}
	if (normalizedAction.confirmationGrant) {
		assertInteractionConfirmationCurrent(
			normalizedAction.confirmationGrant,
			normalizedAction,
			trustedNow,
		);
	}
	const evidenceRaw = asRecord(raw.evidence);
	if (!evidenceRaw) {
		return invalid("Interaction action evidence must be an object.", context);
	}
	const observation =
		raw.observation === null
			? null
			: normalizeInteractionObservation(raw.observation, { actionId });
	const sessionId = nonEmptyString(raw.sessionId, "sessionId", context);
	const adapterId = nonEmptyString(raw.adapterId, "adapterId", context);
	if (
		sessionId !== normalizedSession.sessionId ||
		adapterId !== normalizedSession.adapterId ||
		normalizedAction.sessionId !== sessionId ||
		normalizedAction.adapterId !== adapterId
	) {
		return invalid("Interaction result session or adapter identity mismatch.", {
			...context,
			sessionId,
			adapterId,
		});
	}
	if (
		observation &&
		(observation.sessionId !== sessionId ||
			observation.adapterId !== adapterId ||
			observation.surface.surfaceId !== normalizedAction.surface.surfaceId ||
			observation.surface.kind !== normalizedAction.surface.kind ||
			observation.surface.parentSurfaceId !==
				normalizedAction.surface.parentSurfaceId ||
			observation.surface.generation !== normalizedAction.surface.generation)
	) {
		return invalid(
			"Interaction result observation belongs to another session or adapter.",
			context,
		);
	}
	const unadvertisedResultChannel = observation?.channels.find(
		(channel) => !normalizedCapabilities.observationChannels.includes(channel),
	);
	if (unadvertisedResultChannel) {
		return invalid(
			"Interaction result observation used an unadvertised channel.",
			{ ...context, channel: unadvertisedResultChannel },
		);
	}
	const effectReceipts = normalizeEffectReceipts(raw.effectReceipts);
	const invalidReceipt = effectReceipts.find((receipt) => {
		switch (status) {
			case "SUCCEEDED":
				return receipt.outcome !== "applied" && receipt.outcome !== "noop";
			case "NEEDS_CONFIRMATION":
				return receipt.outcome !== "preview";
			case "UNCERTAIN_EFFECT":
				return (
					receipt.outcome !== "failed" ||
					receipt.failure.acceptance !== "unknown"
				);
			case "FAILED_NO_EFFECT":
				return (
					(receipt.outcome === "failed" &&
						receipt.failure.acceptance !== "rejected") ||
					(receipt.outcome !== "failed" &&
						(receipt.outcome !== "noop" || receipt.idempotency.replayed))
				);
			default:
				return true;
		}
	});
	if (invalidReceipt) {
		return invalid(
			"Interaction result status contradicts its effect receipt.",
			{
				...context,
				status,
				receiptId: invalidReceipt.receiptId,
				receiptOutcome: invalidReceipt.outcome,
			},
		);
	}
	const evidence = Object.freeze({
		beforeObservationId: nullableString(
			evidenceRaw.beforeObservationId,
			"evidence.beforeObservationId",
			context,
		),
		afterObservationId: nullableString(
			evidenceRaw.afterObservationId,
			"evidence.afterObservationId",
			context,
		),
		adapterTraceId: nullableString(
			evidenceRaw.adapterTraceId,
			"evidence.adapterTraceId",
			context,
		),
		actualTarget: nullableString(
			evidenceRaw.actualTarget,
			"evidence.actualTarget",
			context,
		),
	});
	if (evidence.beforeObservationId !== normalizedAction.observationId) {
		return invalid(
			"Interaction result before-observation evidence does not match its action.",
			context,
		);
	}
	if (
		(observation === null) !== (evidence.afterObservationId === null) ||
		(observation !== null &&
			evidence.afterObservationId !== observation.observationId)
	) {
		return invalid(
			"Interaction result observation must match its after-observation evidence.",
			context,
		);
	}
	const result = Object.freeze({
		contractVersion: INTERACTION_CONTRACT_VERSION,
		actionId,
		sessionId,
		adapterId,
		status,
		startedAt,
		completedAt,
		error,
		confirmation,
		evidence,
		effectReceipts,
		observation,
		traceEvents: normalizeTraceEvents(raw.traceEvents, {
			sessionId,
			adapterId,
			surfaceId: normalizedAction.surface.surfaceId,
			actionId,
		}),
	});
	return result as InteractionActionResult;
}

/** Assert that a surface reference is current for one exact session. */
export function assertInteractionSurfaceCurrent(
	session: InteractionSession,
	surface: InteractionSurfaceRef,
): void {
	if (
		surface.sessionId !== session.sessionId ||
		surface.adapterId !== session.adapterId
	) {
		throw new ElizaError(
			"Interaction surface belongs to another session or adapter.",
			{
				code: "INTERACTION_CROSS_SESSION_REFERENCE",
				context: {
					sessionId: session.sessionId,
					surfaceSessionId: surface.sessionId,
					adapterId: session.adapterId,
					surfaceAdapterId: surface.adapterId,
				},
				severity: "fatal",
			},
		);
	}
	if (surface.generation !== session.generation) {
		throw new ElizaError("Interaction surface generation is stale.", {
			code: "STALE_INTERACTION_REFERENCE",
			context: {
				sessionId: session.sessionId,
				surfaceId: surface.surfaceId,
				expectedGeneration: session.generation,
				actualGeneration: surface.generation,
			},
			severity: "ephemeral",
		});
	}
	const registered = session.surfaces.some(
		(candidate) =>
			candidate.surfaceId === surface.surfaceId &&
			candidate.kind === surface.kind &&
			candidate.generation === surface.generation &&
			candidate.parentSurfaceId === surface.parentSurfaceId,
	);
	if (!registered) {
		throw new ElizaError(
			"Interaction surface is not registered to the session.",
			{
				code: "INTERACTION_SURFACE_NOT_FOUND",
				context: {
					sessionId: session.sessionId,
					surfaceId: surface.surfaceId,
				},
				severity: "ephemeral",
			},
		);
	}
}

/**
 * In-memory lease coordinator for resources that cannot safely be shared by
 * concurrent sessions. Hosts persist or distribute this contract when they
 * coordinate across processes; adapters use the same ownership semantics.
 */
export class InteractionLeaseCoordinator {
	private readonly leases = new Map<string, InteractionLease>();
	private readonly resourceKeyByLeaseId = new Map<string, string>();
	static readonly MAX_TTL_MS = 60_000;

	constructor(private readonly clock: Clock = Date.now) {}

	acquire(request: AcquireInteractionLeaseRequest): InteractionLease {
		const now = validClock(this.clock(), "clock");
		if (!Number.isSafeInteger(request.generation) || request.generation < 0) {
			return invalid(
				"Interaction lease generation must be a non-negative safe integer.",
			);
		}
		if (
			!Number.isSafeInteger(request.ttlMs) ||
			request.ttlMs <= 0 ||
			request.ttlMs > InteractionLeaseCoordinator.MAX_TTL_MS
		) {
			return invalid(
				`Interaction lease ttlMs must be a positive safe integer no greater than ${InteractionLeaseCoordinator.MAX_TTL_MS}.`,
			);
		}
		const leaseId = nonEmptyString(request.leaseId, "leaseId");
		const sessionId = nonEmptyString(request.sessionId, "sessionId");
		const ownerId = nonEmptyString(request.ownerId, "ownerId");
		const resourceId = nonEmptyString(request.resourceId, "resourceId");
		const resourceKind = enumValue(
			request.resourceKind,
			"resourceKind",
			INTERACTION_LEASE_RESOURCE_KINDS,
		);
		const key = this.key(resourceKind, resourceId);
		const priorKey = this.resourceKeyByLeaseId.get(leaseId);
		const priorLease = priorKey ? this.currentAt(priorKey, now) : null;
		if (priorLease && priorKey !== key) {
			throw new ElizaError("Interaction lease ID is already bound elsewhere.", {
				code: "INTERACTION_LEASE_CONFLICT",
				context: { leaseId, resourceKind, resourceId },
				severity: "ephemeral",
			});
		}
		const existing = this.currentAt(key, now);
		if (existing) {
			if (
				existing.leaseId === leaseId &&
				existing.sessionId === sessionId &&
				existing.ownerId === ownerId &&
				existing.generation === request.generation
			) {
				return existing;
			}
			throw new ElizaError("Interaction resource is leased by another owner.", {
				code: "INTERACTION_LEASE_CONFLICT",
				context: {
					resourceKind,
					resourceId,
					requestingSessionId: sessionId,
					holdingSessionId: existing.sessionId,
					expiresAt: existing.expiresAt,
				},
				severity: "ephemeral",
			});
		}
		const expiresAtMs = now + request.ttlMs;
		validClock(expiresAtMs, "lease.expiresAt");
		const lease = Object.freeze({
			leaseId,
			sessionId,
			ownerId,
			resourceKind,
			resourceId,
			generation: request.generation,
			acquiredAt: new Date(now).toISOString(),
			expiresAt: new Date(expiresAtMs).toISOString(),
		});
		this.leases.set(key, lease);
		this.resourceKeyByLeaseId.set(leaseId, key);
		return lease;
	}

	renew(lease: InteractionLease, ttlMs: number): InteractionLease {
		const now = validClock(this.clock(), "clock");
		const existing = this.heldAt(lease, now);
		if (
			!Number.isSafeInteger(ttlMs) ||
			ttlMs <= 0 ||
			ttlMs > InteractionLeaseCoordinator.MAX_TTL_MS
		) {
			return invalid(
				"Interaction lease renewal ttlMs is outside the allowed range.",
			);
		}
		const expiresAtMs = now + ttlMs;
		validClock(expiresAtMs, "lease.expiresAt");
		const renewed = Object.freeze({
			...existing,
			expiresAt: new Date(expiresAtMs).toISOString(),
		});
		this.leases.set(
			this.key(existing.resourceKind, existing.resourceId),
			renewed,
		);
		return renewed;
	}

	/** Resolve every action lease against live host-owned coordinator state. */
	assertActionLeases(
		action: InteractionAction,
		session: InteractionSession,
		requirements: readonly InteractionLeaseRequirement[],
	): readonly InteractionLease[] {
		if (
			action.sessionId !== session.sessionId ||
			action.adapterId !== session.adapterId ||
			action.surface.generation !== session.generation
		) {
			throw new ElizaError("Interaction action lease context is stale.", {
				code: "STALE_INTERACTION_LEASE",
				context: { actionId: action.actionId, sessionId: session.sessionId },
				severity: "ephemeral",
			});
		}
		const now = validClock(this.clock(), "clock");
		const resolved = action.leaseIds.map((leaseId) => {
			const key = this.resourceKeyByLeaseId.get(leaseId);
			const lease = key ? this.currentAt(key, now) : null;
			if (
				!lease ||
				lease.sessionId !== session.sessionId ||
				lease.ownerId !== session.ownerId ||
				lease.generation !== session.generation
			) {
				throw new ElizaError(
					"Interaction action lease is missing or foreign.",
					{
						code: "INTERACTION_LEASE_CONFLICT",
						context: { actionId: action.actionId, leaseId },
						severity: "ephemeral",
					},
				);
			}
			return lease;
		});
		for (const requirement of requirements) {
			const resourceId = nonEmptyString(
				requirement.resourceId,
				"requirement.resourceId",
			);
			const resourceKind = enumValue(
				requirement.resourceKind,
				"requirement.resourceKind",
				INTERACTION_LEASE_RESOURCE_KINDS,
			);
			if (
				!resolved.some(
					(lease) =>
						lease.resourceKind === resourceKind &&
						lease.resourceId === resourceId,
				)
			) {
				throw new ElizaError(
					"Interaction action lacks a required resource lease.",
					{
						code: "INTERACTION_LEASE_CONFLICT",
						context: {
							actionId: action.actionId,
							resourceKind,
							resourceId,
						},
						severity: "ephemeral",
					},
				);
			}
		}
		return Object.freeze(resolved);
	}

	release(lease: InteractionLease): boolean {
		const key = this.key(lease.resourceKind, lease.resourceId);
		const existing = this.currentAt(key, validClock(this.clock(), "clock"));
		if (!existing) return false;
		if (
			existing.leaseId !== lease.leaseId ||
			existing.sessionId !== lease.sessionId ||
			existing.ownerId !== lease.ownerId ||
			existing.generation !== lease.generation
		) {
			throw new ElizaError(
				"Interaction lease release does not match its owner.",
				{
					code: "INTERACTION_LEASE_CONFLICT",
					context: {
						resourceKind: lease.resourceKind,
						resourceId: lease.resourceId,
						leaseId: lease.leaseId,
						holdingLeaseId: existing.leaseId,
					},
					severity: "ephemeral",
				},
			);
		}
		this.resourceKeyByLeaseId.delete(existing.leaseId);
		return this.leases.delete(key);
	}

	assertHeld(lease: InteractionLease): void {
		this.heldAt(lease, validClock(this.clock(), "clock"));
	}

	private heldAt(lease: InteractionLease, now: number): InteractionLease {
		const key = this.key(lease.resourceKind, lease.resourceId);
		const existing = this.currentAt(key, now);
		if (
			!existing ||
			existing.leaseId !== lease.leaseId ||
			existing.sessionId !== lease.sessionId ||
			existing.ownerId !== lease.ownerId ||
			existing.generation !== lease.generation
		) {
			throw new ElizaError("Interaction lease is missing, expired, or stale.", {
				code: "STALE_INTERACTION_LEASE",
				context: {
					resourceKind: lease.resourceKind,
					resourceId: lease.resourceId,
					leaseId: lease.leaseId,
				},
				severity: "ephemeral",
			});
		}
		return existing;
	}

	private currentAt(key: string, now: number): InteractionLease | null {
		const lease = this.leases.get(key);
		if (!lease) return null;
		if (Date.parse(lease.expiresAt) <= now) {
			this.leases.delete(key);
			this.resourceKeyByLeaseId.delete(lease.leaseId);
			return null;
		}
		return lease;
	}

	private key(
		resourceKind: InteractionLeaseResourceKind,
		resourceId: string,
	): string {
		return `${resourceKind}:${resourceId}`;
	}
}

export interface AuthorizeInteractionDispatchOptions {
	session: InteractionSession;
	capabilities: InteractionCapabilitySet;
	now?: number;
	clock?: Clock;
	profileGrantVerifier?: InteractionProfileGrantVerifier;
	confirmationGrantConsumer?: InteractionConfirmationGrantConsumer;
	leaseCoordinator?: InteractionLeaseCoordinator;
	leaseRequirements: readonly InteractionLeaseRequirement[];
}

/**
 * Atomically authorize one adapter dispatch before any side effect. The helper
 * awaits an atomic consume-if-current operation after all session and lease
 * checks, so concurrent or cross-process replay attempts cannot both reach an
 * adapter.
 */
export async function authorizeInteractionDispatch(
	value: unknown,
	options: AuthorizeInteractionDispatchOptions,
): Promise<AuthorizedInteractionAction> {
	if (options.now !== undefined && options.clock) {
		return invalid(
			"Interaction dispatch accepts either now or clock, not both.",
		);
	}
	const clock = options.clock ?? (() => options.now ?? Date.now());
	const trustedNow = validClock(clock());
	const capabilities = normalizeInteractionCapabilitySet(options.capabilities);
	const session = assertInteractionSessionExecutable(options.session, {
		capabilities,
		now: trustedNow,
		profileGrantVerifier: options.profileGrantVerifier,
	});
	const action = normalizeInteractionAction(value, {
		session,
		now: trustedNow,
		// The awaited consume-if-current operation below is the authorization
		// authority. This verifier only enables structural normalization.
		confirmationGrantVerifier: options.confirmationGrantConsumer
			? { verify: () => true }
			: undefined,
	});
	if (Date.parse(action.requestedAt) < Date.parse(session.createdAt)) {
		return invalid("Interaction action predates its session.", {
			actionId: action.actionId,
			sessionId: session.sessionId,
		});
	}
	const leaseRequirements = options.leaseRequirements;
	if (action.leaseIds.length > 0 || leaseRequirements.length > 0) {
		if (!options.leaseCoordinator) {
			return invalid("Interaction action leases require a host coordinator.", {
				actionId: action.actionId,
			});
		}
		options.leaseCoordinator.assertActionLeases(
			action,
			session,
			leaseRequirements,
		);
	}
	if (action.confirmationGrant) {
		if (!options.confirmationGrantConsumer) {
			return invalid(
				"Confirmed interaction actions require a consume-once host issuer.",
				{ actionId: action.actionId },
			);
		}
		await options.confirmationGrantConsumer.consume(
			action.confirmationGrant,
			action,
			trustedNow,
		);
	}
	const authorizedAt = validClock(clock());
	const currentSession = assertInteractionSessionExecutable(options.session, {
		capabilities,
		now: authorizedAt,
		profileGrantVerifier: options.profileGrantVerifier,
	});
	if (
		currentSession.sessionId !== session.sessionId ||
		currentSession.ownerId !== session.ownerId ||
		currentSession.adapterId !== session.adapterId ||
		currentSession.generation !== session.generation
	) {
		throw new ElizaError(
			"Interaction session changed while dispatch authorization was pending.",
			{
				code: "STALE_INTERACTION_REFERENCE",
				context: {
					actionId: action.actionId,
					sessionId: session.sessionId,
					initialGeneration: session.generation,
					currentGeneration: currentSession.generation,
				},
				severity: "ephemeral",
			},
		);
	}
	assertInteractionSurfaceCurrent(currentSession, action.surface);
	if (action.confirmationGrant) {
		assertInteractionConfirmationCurrent(
			action.confirmationGrant,
			action,
			authorizedAt,
		);
	}
	if (action.leaseIds.length > 0 || leaseRequirements.length > 0) {
		options.leaseCoordinator?.assertActionLeases(
			action,
			currentSession,
			leaseRequirements,
		);
	}
	const authorized = { ...action } as InteractionAction & {
		[authorizedInteractionAction]: number;
	};
	Object.defineProperty(authorized, authorizedInteractionAction, {
		value: authorizedAt,
		enumerable: false,
		configurable: false,
		writable: false,
	});
	return Object.freeze(authorized) as AuthorizedInteractionAction;
}
