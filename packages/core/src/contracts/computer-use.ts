/**
 * Canonical, browser-safe contracts for semantic browser and native computer
 * control. Adapters advertise capabilities before dispatch, bind every action
 * to one session and surface generation, and return side-effect-safe outcomes
 * that reuse the runtime's existing effect receipts as mutation proof.
 */

import { ElizaError } from "../errors.ts";
import {
	type EffectReceipt,
	normalizeEffectReceipts,
} from "../types/effects.ts";

export const INTERACTION_CONTRACT_VERSION = 1 as const;

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

export interface InteractionActionResult {
	contractVersion: typeof INTERACTION_CONTRACT_VERSION;
	actionId: string;
	sessionId: string;
	adapterId: string;
	status: InteractionOutcomeStatus;
	startedAt: string;
	completedAt: string;
	error: InteractionActionError | null;
	confirmation: InteractionConfirmationPreview | null;
	evidence: InteractionActionEvidence;
	effectReceipts: readonly EffectReceipt[];
	observation: InteractionObservation | null;
}

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

export interface InteractionAdapter {
	readonly id: string;
	capabilities(): Promise<InteractionCapabilitySet>;
	observe(
		session: InteractionSession,
		surface: InteractionSurfaceRef,
	): Promise<InteractionObservation>;
	execute(action: InteractionAction): Promise<InteractionActionResult>;
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
	return new Date(parsed).toISOString();
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

export function normalizeInteractionObservation(
	value: unknown,
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
	return Object.freeze({
		contractVersion: INTERACTION_CONTRACT_VERSION,
		observationId,
		sessionId,
		adapterId,
		surface,
		sequence: nonNegativeInteger(raw.sequence, "sequence", context),
		observedAt: isoTimestamp(raw.observedAt, "observedAt", context),
		channels: enumArray(
			raw.channels,
			"channels",
			INTERACTION_OBSERVATION_CHANNELS,
			context,
		),
		artifacts: Object.freeze(
			raw.artifacts.map((entry, index) => normalizeArtifact(entry, index)),
		),
		viewport:
			raw.viewport === null ? null : normalizeRect(raw.viewport, "viewport"),
		cursor: raw.cursor === null ? null : normalizePoint(raw.cursor, "cursor"),
		redactions: Object.freeze(
			raw.redactions.map((entry, index) => normalizeRedaction(entry, index)),
		),
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
		actionDigest: nonEmptyString(raw.actionDigest, "actionDigest", context),
		requestedAt,
		expiresAt,
	});
}

export function normalizeInteractionActionResult(
	value: unknown,
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
	const status = enumValue(
		raw.status,
		"status",
		INTERACTION_OUTCOME_STATUSES,
		context,
	);
	const startedAt = isoTimestamp(raw.startedAt, "startedAt", context);
	const completedAt = isoTimestamp(raw.completedAt, "completedAt", context);
	if (Date.parse(completedAt) < Date.parse(startedAt)) {
		return invalid("Interaction action completed before it started.", context);
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
	if (confirmation && confirmation.actionId !== actionId) {
		return invalid(
			"Interaction confirmation must authorize the result action.",
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
	const evidenceRaw = asRecord(raw.evidence);
	if (!evidenceRaw) {
		return invalid("Interaction action evidence must be an object.", context);
	}
	const observation =
		raw.observation === null
			? null
			: normalizeInteractionObservation(raw.observation);
	const sessionId = nonEmptyString(raw.sessionId, "sessionId", context);
	const adapterId = nonEmptyString(raw.adapterId, "adapterId", context);
	if (
		observation &&
		(observation.sessionId !== sessionId || observation.adapterId !== adapterId)
	) {
		return invalid(
			"Interaction result observation belongs to another session or adapter.",
			context,
		);
	}
	if (
		observation &&
		nullableString(
			evidenceRaw.afterObservationId,
			"evidence.afterObservationId",
			context,
		) !== observation.observationId
	) {
		return invalid(
			"Interaction result evidence must identify its attached observation.",
			context,
		);
	}
	return Object.freeze({
		contractVersion: INTERACTION_CONTRACT_VERSION,
		actionId,
		sessionId,
		adapterId,
		status,
		startedAt,
		completedAt,
		error,
		confirmation,
		evidence: Object.freeze({
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
		}),
		effectReceipts: normalizeEffectReceipts(raw.effectReceipts),
		observation,
	});
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
			candidate.generation === surface.generation,
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

	constructor(private readonly clock: Clock = Date.now) {}

	acquire(request: AcquireInteractionLeaseRequest): InteractionLease {
		const now = this.clock();
		if (!Number.isInteger(request.generation) || request.generation < 0) {
			return invalid("Interaction lease generation must be non-negative.");
		}
		if (!Number.isFinite(request.ttlMs) || request.ttlMs <= 0) {
			return invalid("Interaction lease ttlMs must be positive.");
		}
		for (const field of [
			"leaseId",
			"sessionId",
			"ownerId",
			"resourceId",
		] as const) {
			nonEmptyString(request[field], field);
		}
		enumValue(
			request.resourceKind,
			"resourceKind",
			INTERACTION_LEASE_RESOURCE_KINDS,
		);
		const key = this.key(request.resourceKind, request.resourceId);
		const existing = this.currentAt(key, now);
		if (
			existing &&
			(existing.sessionId !== request.sessionId ||
				existing.ownerId !== request.ownerId ||
				existing.generation !== request.generation)
		) {
			throw new ElizaError("Interaction resource is leased by another owner.", {
				code: "INTERACTION_LEASE_CONFLICT",
				context: {
					resourceKind: request.resourceKind,
					resourceId: request.resourceId,
					requestingSessionId: request.sessionId,
					holdingSessionId: existing.sessionId,
					expiresAt: existing.expiresAt,
				},
				severity: "ephemeral",
			});
		}
		const lease = Object.freeze({
			leaseId: request.leaseId,
			sessionId: request.sessionId,
			ownerId: request.ownerId,
			resourceKind: request.resourceKind,
			resourceId: request.resourceId,
			generation: request.generation,
			acquiredAt: new Date(now).toISOString(),
			expiresAt: new Date(now + request.ttlMs).toISOString(),
		});
		this.leases.set(key, lease);
		return lease;
	}

	release(lease: InteractionLease): boolean {
		const key = this.key(lease.resourceKind, lease.resourceId);
		const existing = this.currentAt(key, this.clock());
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
		return this.leases.delete(key);
	}

	assertHeld(lease: InteractionLease): void {
		const key = this.key(lease.resourceKind, lease.resourceId);
		const existing = this.currentAt(key, this.clock());
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
	}

	private currentAt(key: string, now: number): InteractionLease | null {
		const lease = this.leases.get(key);
		if (!lease) return null;
		if (Date.parse(lease.expiresAt) <= now) {
			this.leases.delete(key);
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
