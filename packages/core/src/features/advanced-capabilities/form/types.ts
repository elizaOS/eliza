/**
 * @module types
 * @description Core type definitions for the Form Plugin
 *
 * ## The Core Insight
 *
 * Forms are **guardrails for agent-guided user journeys**.
 *
 * Without structure, agents wander. They forget what they're collecting,
 * miss required information, and can't reliably guide users to outcomes.
 * These types define the rails that keep agents on track.
 *
 * - **FormDefinition** = The journey map (what stops are required)
 * - **FormControl** = A stop on the journey (what info to collect)
 * - **FormSession** = Progress through the journey (where we are)
 * - **FormSubmission** = Journey complete (the outcome)
 *
 * ## Design Principles
 *
 * 1. **Agent-Native**: Designed for conversational, asynchronous interactions.
 *    No form UI - the agent extracts data and guides the conversation.
 *
 * 2. **Future-Compatible**: Many fields are optional with sensible defaults.
 *    The `meta` field on most interfaces allows arbitrary extension.
 *
 * 3. **Scoped Sessions**: Sessions are keyed by (entityId + roomId) because
 *    a user might be on different journeys in different rooms.
 *
 * 4. **Effort-Aware**: Form data is retained based on user effort invested.
 *    Someone who spent 2 hours deserves longer retention than 2 minutes.
 *
 * 5. **TypeScript-First**: Types use discriminated unions, generics, and
 *    template literals for excellent IDE support and type safety.
 */

import type { IAgentRuntime, JsonValue, UUID } from "../../../types/index.ts";

// ============================================================================
// FORM CONTROL - Individual field definition
// ============================================================================

/**
 * Select/choice option for select-type fields.
 */
export interface FormControlOption {
	value: string;
	label: string;
	description?: string;
}

/**
 * File upload configuration.
 */
export interface FormControlFileOptions {
	/** MIME type patterns, e.g., ['image/*', 'application/pdf'] */
	accept?: string[];
	/** Maximum file size in bytes */
	maxSize?: number;
	/** Maximum number of files (for multiple uploads) */
	maxFiles?: number;
}

/**
 * Conditional field dependency.
 */
export interface FormControlDependency {
	/** Key of the field this one depends on */
	field: string;
	/** When should this field be shown/asked */
	condition: "exists" | "equals" | "not_equals";
	/** Value to compare against for equals/not_equals */
	value?: JsonValue;
}

/**
 * UI hints for future frontends.
 */
export interface FormControlUI {
	/** Section name for grouping fields */
	section?: string;
	/** Display order within section */
	order?: number;
	/** Placeholder text for input fields */
	placeholder?: string;
	/** Help text shown below input */
	helpText?: string;
	/** Custom widget type identifier */
	widget?: string;
}

/**
 * Localization for a field.
 */
export interface FormControlI18n {
	label?: string;
	description?: string;
	askPrompt?: string;
	helpText?: string;
}

/**
 * FormControl - The central field abstraction
 */
export interface FormControl {
	// ═══ IDENTITY ═══
	/** Unique key within the form. Used in values object. */
	key: string;
	/** Human-readable label. Shown to user if not using askPrompt. */
	label: string;
	/**
	 * Field type. Built-in types: 'text', 'number', 'email', 'boolean', 'select', 'date', 'file'.
	 * Custom types can be registered via FormService.registerType().
	 */
	type: string;

	// ═══ BEHAVIOR ═══
	/** If true, form cannot be submitted without this field. Default: false */
	required?: boolean;
	/** If true, accepts array of values. Default: false */
	multiple?: boolean;
	/** If true, value cannot be changed after initial set. Default: false */
	readonly?: boolean;
	/** If true, extract silently but never ask directly. Default: false */
	hidden?: boolean;
	/** If true, agent should not echo value back (passwords, tokens). Default: false */
	sensitive?: boolean;

	// ═══ DATABASE BINDING ═══
	dbbind?: string;

	// ═══ VALIDATION ═══
	/** Regex pattern for validation. Applied to string representation. */
	pattern?: string;
	/** Minimum value (for numbers) or minimum length (for strings) */
	min?: number;
	/** Maximum value (for numbers) or maximum length (for strings) */
	max?: number;
	/** Minimum string length (explicit, for when min is used for value) */
	minLength?: number;
	/** Maximum string length (explicit, for when max is used for value) */
	maxLength?: number;
	/** Allowed values (for string enums without select options) */
	enum?: string[];

	// ═══ SELECT OPTIONS ═══
	/** Options for 'select' type fields */
	options?: FormControlOption[];

	// ═══ FILE OPTIONS ═══
	/** Configuration for 'file' type fields */
	file?: FormControlFileOptions;

	// ═══ DEFAULTS & CONDITIONS ═══
	/** Default value if user doesn't provide one */
	defaultValue?: JsonValue;
	/** Conditional display/requirement based on another field */
	dependsOn?: FormControlDependency;

	// ═══ ACCESS CONTROL ═══
	roles?: string[];

	// ═══ AGENT HINTS ═══
	description?: string;
	askPrompt?: string;
	extractHints?: string[];
	confirmThreshold?: number;
	/** Example value for "give me an example" request */
	example?: string;

	// ═══ UI HINTS ═══
	/** Hints for future GUI rendering */
	ui?: FormControlUI;

	// ═══ I18N ═══
	/** Localized versions of label, description, askPrompt */
	i18n?: Record<string, FormControlI18n>;

	// ═══ NESTED FIELDS ═══
	fields?: FormControl[];

	// ═══ EXTENSION ═══
	meta?: Record<string, JsonValue>;
}

// ============================================================================
// FORM DEFINITION - The container for controls
// ============================================================================

export interface FormDefinitionUX {
	/** Allow "undo" to revert last change. Default: true */
	allowUndo?: boolean;
	/** Allow "skip" for optional fields. Default: true */
	allowSkip?: boolean;
	/** Maximum undo history size. Default: 5 */
	maxUndoSteps?: number;
	/** Show examples when user asks. Default: true */
	showExamples?: boolean;
	/** Show explanations when user asks. Default: true */
	showExplanations?: boolean;
	/** Allow autofill from previous submissions. Default: true */
	allowAutofill?: boolean;
}

export interface FormDefinitionTTL {
	/** Minimum retention in days, even with no effort. Default: 14 */
	minDays?: number;
	/** Maximum retention in days, regardless of effort. Default: 90 */
	maxDays?: number;
	/** Days added per minute of user effort. Default: 0.5. */
	effortMultiplier?: number;
}

export interface FormDefinitionNudge {
	/** Enable nudge messages. Default: true */
	enabled?: boolean;
	/** Hours of inactivity before first nudge. Default: 48 */
	afterInactiveHours?: number;
	/** Maximum nudge messages to send. Default: 3 */
	maxNudges?: number;
	/** Custom nudge message template */
	message?: string;
}

export interface FormDefinitionHooks {
	/** Called when session starts */
	onStart?: string;
	/** Called when any field changes */
	onFieldChange?: string;
	/** Called when all required fields are filled */
	onReady?: string;
	/** Called on successful submission */
	onSubmit?: string;
	/** Called when user cancels */
	onCancel?: string;
	/** Called when session expires */
	onExpire?: string;
}

export interface FormDefinitionI18n {
	name?: string;
	description?: string;
}

export interface FormDefinition {
	// ═══ IDENTITY ═══
	/** Unique identifier for this form definition */
	id: string;
	/** Human-readable name shown in UI and agent responses */
	name: string;
	/** Description of what this form collects */
	description?: string;
	/** Schema version for migrations. Default: 1. */
	version?: number;

	// ═══ CONTROLS ═══
	/** Array of field definitions */
	controls: FormControl[];

	// ═══ LIFECYCLE ═══
	status?: "draft" | "active" | "deprecated";

	// ═══ PERMISSIONS ═══
	roles?: string[];

	// ═══ BEHAVIOR ═══
	allowMultiple?: boolean;

	// ═══ UX OPTIONS ═══
	ux?: FormDefinitionUX;

	// ═══ TTL (Smart Retention) ═══
	ttl?: FormDefinitionTTL;

	// ═══ NUDGE ═══
	nudge?: FormDefinitionNudge;

	// ═══ HOOKS ═══
	hooks?: FormDefinitionHooks;

	// ═══ DEBUG ═══
	debug?: boolean;

	// ═══ I18N ═══
	i18n?: Record<string, FormDefinitionI18n>;

	// ═══ EXTENSION ═══
	meta?: Record<string, JsonValue>;
}

// ============================================================================
// FIELD STATE - Runtime state of a single field
// ============================================================================

export interface FieldFile {
	/** Unique identifier for the file */
	id: string;
	/** Original filename */
	name: string;
	/** MIME type */
	mimeType: string;
	/** Size in bytes */
	size: number;
	/** URL to access the file */
	url: string;
}

export interface FieldState {
	// ═══ STATUS ═══
	status: "empty" | "filled" | "uncertain" | "invalid" | "skipped" | "pending";

	// ═══ VALUE ═══
	/** The current value (undefined if empty/skipped) */
	value?: JsonValue;

	// ═══ CONFIDENCE ═══
	confidence?: number;
	/** Other possible interpretations of user message */
	alternatives?: JsonValue[];

	// ═══ VALIDATION ═══
	/** Validation error message if status is 'invalid' */
	error?: string;

	// ═══ FILES ═══
	/** File metadata for file-type fields */
	files?: FieldFile[];

	// ═══ AUDIT TRAIL ═══
	source?:
		| "extraction"
		| "autofill"
		| "default"
		| "manual"
		| "correction"
		| "external";
	/** ID of message that provided this value */
	messageId?: string;
	/** When the value was last updated */
	updatedAt?: number;
	/** When user confirmed an uncertain value */
	confirmedAt?: number;

	// ═══ COMPOSITE TYPES ═══
	subFields?: Record<string, FieldState>;

	// ═══ EXTERNAL TYPES ═══
	externalState?: {
		/** Current status of the external interaction */
		status: "pending" | "confirmed" | "failed" | "expired";
		/** Reference used to match external events */
		reference?: string;
		/** Instructions shown to user (cached from activation) */
		instructions?: string;
		/** Address shown to user (cached from activation) */
		address?: string;
		/** When the external process was activated */
		activatedAt?: number;
		/** When the external process was confirmed */
		confirmedAt?: number;
		/** Data from the external confirmation (txId, signature, etc.) */
		externalData?: Record<string, JsonValue>;
	};

	// ═══ EXTENSION ═══
	meta?: Record<string, JsonValue>;
}

// ============================================================================
// FORM SESSION - Active form being filled
// ============================================================================

export interface FieldHistoryEntry {
	/** Which field was changed */
	field: string;
	/** Previous value (to restore) */
	oldValue: JsonValue;
	/** New value (for audit) */
	newValue: JsonValue;
	/** When the change happened */
	timestamp: number;
}

export interface SessionEffort {
	/** Number of messages processed for this form */
	interactionCount: number;
	/** Total time from first to last interaction */
	timeSpentMs: number;
	/** When user first interacted with this form */
	firstInteractionAt: number;
	/** When user last interacted with this form */
	lastInteractionAt: number;
}

export interface FormSession {
	// ═══ IDENTITY ═══
	/** Unique session ID */
	id: string;
	/** Reference to FormDefinition.id */
	formId: string;
	/** Form version at session start (for migration handling) */
	formVersion?: number;

	// ═══ SCOPING (user + room) ═══
	/** The user filling the form */
	entityId: UUID;
	/** The room where conversation is happening */
	roomId: UUID;

	// ═══ STATUS ═══
	status:
		| "active"
		| "ready"
		| "submitted"
		| "stashed"
		| "cancelled"
		| "expired";

	// ═══ FIELD DATA ═══
	/** Current state of each field, keyed by control.key */
	fields: Record<string, FieldState>;

	// ═══ HISTORY (for undo) ═══
	/** Recent changes for undo functionality */
	history: FieldHistoryEntry[];

	// ═══ HIERARCHY ═══
	parentSessionId?: string;

	// ═══ CONTEXT ═══
	context?: Record<string, JsonValue>;
	/** User's locale for i18n */
	locale?: string;

	// ═══ TRACKING ═══
	/** Last field agent asked about (for skip functionality) */
	lastAskedField?: string;
	/** Last message processed (for deduplication) */
	lastMessageId?: string;
	/** True if we asked "are you sure you want to cancel?" */
	cancelConfirmationAsked?: boolean;

	// ═══ EFFORT (for smart TTL) ═══
	effort: SessionEffort;

	// ═══ TTL ═══
	/** When this session expires (timestamp) */
	expiresAt: number;
	/** True if we already warned about expiration */
	expirationWarned?: boolean;
	/** Number of nudge messages sent */
	nudgeCount?: number;
	/** When we last sent a nudge */
	lastNudgeAt?: number;

	// ═══ TIMESTAMPS ═══
	/** When session was created */
	createdAt: number;
	/** When session was last modified */
	updatedAt: number;
	/** When session was submitted (if status is 'submitted') */
	submittedAt?: number;

	// ═══ EXTENSION ═══
	meta?: Record<string, JsonValue>;
}

// ============================================================================
// FORM SUBMISSION - Completed form data
// ============================================================================

export interface FormSubmission {
	/** Unique submission ID */
	id: string;
	/** Which form definition this is for */
	formId: string;
	/** Form version at submission time */
	formVersion?: number;
	/** The session that produced this submission */
	sessionId: string;
	/** Who submitted */
	entityId: UUID;

	/** Field values keyed by control.key */
	values: Record<string, JsonValue>;
	/** Same values but keyed by dbbind. */
	mappedValues?: Record<string, JsonValue>;
	/** File attachments keyed by control.key */
	files?: Record<string, FieldFile[]>;

	/** When the form was submitted */
	submittedAt: number;

	meta?: Record<string, JsonValue>;
}

// ============================================================================
// TYPE HANDLER - Custom type validation & formatting
// ============================================================================

/**
 * TypeHandler - Custom type behavior.
 *
 * Used by the validation pipeline for simple single-value types. For
 * composite or external types, use ControlType instead.
 */
export interface TypeHandler {
	/** Validate a value. Return { valid: true } or { valid: false, error: '...' } */
	validate?: (
		value: JsonValue,
		control: FormControl,
	) => { valid: boolean; error?: string };
	/** Parse string input to appropriate type */
	parse?: (value: string) => JsonValue;
	/** Format value for display */
	format?: (value: JsonValue) => string;
	/** Description for LLM extraction. */
	extractionPrompt?: string;
}

// ============================================================================
// CONTROL TYPE - widget/type registry
// ============================================================================

export interface ValidationResult {
	valid: boolean;
	error?: string;
}

export interface ActivationContext {
	/** Runtime for accessing services */
	runtime: IAgentRuntime;
	/** The current form session */
	session: FormSession;
	/** The control being activated */
	control: FormControl;
	/** Filled subcontrol values, keyed by subcontrol key */
	subValues: Record<string, JsonValue>;
}

export interface ExternalActivation {
	/** Human-readable instructions for the user */
	instructions: string;
	/** Unique reference to match external events (e.g., memo, tx reference) */
	reference: string;
	/** Optional address (payment address, signing endpoint, etc.) */
	address?: string;
	/** When this activation expires (timestamp) */
	expiresAt?: number;
	/** Arbitrary metadata from the widget */
	meta?: Record<string, JsonValue>;
}

export interface ExternalFieldState {
	/** Current status of the external interaction */
	status: "pending" | "confirmed" | "failed" | "expired";
	/** Reference used to match external events */
	reference?: string;
	/** Instructions shown to user (cached from activation) */
	instructions?: string;
	/** Address shown to user (cached from activation) */
	address?: string;
	/** When the external process was activated */
	activatedAt?: number;
	/** When the external process was confirmed */
	confirmedAt?: number;
	/** Data from the external confirmation (txId, signature, etc.) */
	externalData?: Record<string, JsonValue>;
}

export interface ControlType {
	/** Unique identifier for this control type */
	id: string;

	/** If true, this is a built-in type that should warn on override. */
	builtin?: boolean;

	// ═══ SIMPLE TYPE METHODS ═══
	validate?: (value: JsonValue, control: FormControl) => ValidationResult;
	parse?: (value: string) => JsonValue;
	format?: (value: JsonValue) => string;
	extractionPrompt?: string;

	// ═══ COMPOSITE TYPE METHODS ═══
	getSubControls?: (
		control: FormControl,
		runtime: IAgentRuntime,
	) => FormControl[];

	// ═══ EXTERNAL TYPE METHODS ═══
	activate?: (context: ActivationContext) => Promise<ExternalActivation>;
	deactivate?: (context: ActivationContext) => Promise<void>;
}

// ============================================================================
// FORM WIDGET EVENTS - Events emitted by evaluator
// ============================================================================

export type FormWidgetEventType =
	| "FORM_FIELD_EXTRACTED"
	| "FORM_SUBFIELD_UPDATED"
	| "FORM_SUBCONTROLS_FILLED"
	| "FORM_EXTERNAL_ACTIVATED"
	| "FORM_FIELD_CONFIRMED"
	| "FORM_FIELD_CANCELLED";

export interface FormFieldExtractedEvent {
	type: "FORM_FIELD_EXTRACTED";
	sessionId: string;
	field: string;
	value: JsonValue;
	confidence: number;
}

export interface FormSubfieldUpdatedEvent {
	type: "FORM_SUBFIELD_UPDATED";
	sessionId: string;
	parentField: string;
	subField: string;
	value: JsonValue;
	confidence: number;
}

export interface FormSubcontrolsFilledEvent {
	type: "FORM_SUBCONTROLS_FILLED";
	sessionId: string;
	field: string;
	subValues: Record<string, JsonValue>;
}

export interface FormExternalActivatedEvent {
	type: "FORM_EXTERNAL_ACTIVATED";
	sessionId: string;
	field: string;
	activation: ExternalActivation;
}

export interface FormFieldConfirmedEvent {
	type: "FORM_FIELD_CONFIRMED";
	sessionId: string;
	field: string;
	value: JsonValue;
	externalData?: Record<string, JsonValue>;
}

export interface FormFieldCancelledEvent {
	type: "FORM_FIELD_CANCELLED";
	sessionId: string;
	field: string;
	reason: string;
}

export type FormWidgetEvent =
	| FormFieldExtractedEvent
	| FormSubfieldUpdatedEvent
	| FormSubcontrolsFilledEvent
	| FormExternalActivatedEvent
	| FormFieldConfirmedEvent
	| FormFieldCancelledEvent;

// ============================================================================
// FORM CONTEXT STATE - Provider output
// ============================================================================

export interface FilledFieldSummary {
	key: string;
	label: string;
	/** Formatted value safe to show user (respects sensitive flag) */
	displayValue: string;
}

export interface MissingFieldSummary {
	key: string;
	label: string;
	description?: string;
	/** How agent should ask for this field */
	askPrompt?: string;
}

export interface UncertainFieldSummary {
	key: string;
	label: string;
	/** The uncertain value */
	value: JsonValue;
	/** How confident the LLM was */
	confidence: number;
}

export interface PendingExternalFieldSummary {
	/** Field key */
	key: string;
	/** Field label for display */
	label: string;
	/** Instructions for the user */
	instructions: string;
	/** Reference for matching */
	reference: string;
	/** When the external process was activated */
	activatedAt: number;
	/** Optional address (payment address, etc.) */
	address?: string;
}

export interface FormContextState {
	/** True if there's an active form in this room */
	hasActiveForm: boolean;
	/** Current form ID */
	formId?: string;
	/** Current form name */
	formName?: string;
	/** Completion percentage (0-100) */
	progress: number;
	/** Fields that have been filled */
	filledFields: FilledFieldSummary[];
	/** Required fields still needed */
	missingRequired: MissingFieldSummary[];
	/** Fields needing user confirmation */
	uncertainFields: UncertainFieldSummary[];
	/** Next field to ask about */
	nextField: FormControl | null;
	/** Current session status */
	status?: FormSession["status"];
	/** Number of stashed forms */
	stashedCount?: number;
	/** True if we asked "are you sure you want to cancel?" */
	pendingCancelConfirmation?: boolean;
	/** External fields waiting for confirmation. */
	pendingExternalFields: PendingExternalFieldSummary[];
}

// ============================================================================
// INTENT SYSTEM
// ============================================================================

export type FormIntent =
	// Lifecycle - affects session state
	| "fill_form"
	| "submit"
	| "stash"
	| "restore"
	| "cancel"
	// UX Magic - helper actions
	| "undo"
	| "skip"
	| "explain"
	| "example"
	| "progress"
	| "autofill"
	// Fallback
	| "other";

export interface ExtractionResult {
	/** Which field this is for */
	field: string;
	/** Extracted value */
	value: JsonValue;
	/** LLM confidence (0-1) */
	confidence: number;
	/** LLM reasoning (for debug mode) */
	reasoning?: string;
	/** Other possible values if uncertain */
	alternatives?: JsonValue[];
	/** True if user is correcting previous value */
	isCorrection?: boolean;
}

export interface IntentResult {
	/** What the user wants to do */
	intent: FormIntent;
	/** Extracted field values (for fill_form intent) */
	extractions: ExtractionResult[];
	/** Target form ID for restore if multiple stashed */
	targetFormId?: string;
}

// ============================================================================
// DEFAULTS
// ============================================================================

export const FORM_CONTROL_DEFAULTS = {
	type: "text",
	required: false,
	confirmThreshold: 0.8,
} as const;

export const FORM_DEFINITION_DEFAULTS = {
	version: 1,
	status: "active" as const,
	ux: {
		allowUndo: true,
		allowSkip: true,
		maxUndoSteps: 5,
		showExamples: true,
		showExplanations: true,
		allowAutofill: true,
	},
	ttl: {
		minDays: 14,
		maxDays: 90,
		effortMultiplier: 0.5,
	},
	nudge: {
		enabled: true,
		afterInactiveHours: 48,
		maxNudges: 3,
	},
	debug: false,
} as const;

// ============================================================================
// COMPONENT TYPES - For storage
// ============================================================================

export const FORM_SESSION_COMPONENT = "form_session";
export const FORM_SUBMISSION_COMPONENT = "form_submission";
export const FORM_AUTOFILL_COMPONENT = "form_autofill";

export interface FormAutofillData {
	formId: string;
	values: Record<string, JsonValue>;
	updatedAt: number;
}
