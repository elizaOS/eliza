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

import type { JsonValue, UUID } from "@elizaos/core";

// ============================================================================
// FORM CONTROL - Individual field definition
// ============================================================================

/**
 * Select/choice option for select-type fields.
 *
 * WHY separate from simple string[]:
 * - Labels can differ from values (display "United States", submit "US")
 * - Optional description enables rich select UIs in future
 * - Allows localization of labels without changing values
 */
export interface FormControlOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * File upload configuration.
 *
 * WHY separate interface:
 * - File uploads have unique concerns (size, type, count)
 * - Not all controls need these options
 * - Allows file-specific validation without polluting base control
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
 *
 * WHY this exists:
 * - Some fields only make sense if another field has a value
 * - Example: "State" only relevant if "Country" is "US"
 * - The agent should skip asking about dependent fields until parent is filled
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
 *
 * WHY include UI hints in an agent-native form:
 * - Forms may eventually render in GUI
 * - Provides grouping hints to the agent for logical conversation flow
 * - Widget hints allow custom input components
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
 *
 * WHY per-field i18n:
 * - Allows gradual localization (not all-or-nothing)
 * - Agent prompts need localized versions too
 * - Keeps localization close to the field it affects
 */
export interface FormControlI18n {
  label?: string;
  description?: string;
  askPrompt?: string;
  helpText?: string;
}

/**
 * FormControl - The central field abstraction
 *
 * This is the heart of the form system. Each FormControl defines:
 * - What data to collect (key, type)
 * - How to validate it (pattern, min/max, required)
 * - How the agent should ask for it (askPrompt, extractHints)
 * - How to store it (dbbind)
 *
 * WHY such a rich interface:
 * - Agent needs context to extract values intelligently
 * - Validation needs to happen at extraction time, not just submission
 * - Multiple systems (agent, storage, UI) need different views of the same field
 *
 * WHY `type` is a string, not an enum:
 * - Allows custom types without changing core code
 * - Plugins can register handlers for domain-specific types
 * - Example: 'solana_address', 'evm_address', 'phone'
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
  /**
   * Database column name. Defaults to key if not specified.
   *
   * WHY this exists:
   * - Form field names can be user-friendly ("Email Address")
   * - Database columns often have conventions ("email_address")
   * - Consuming plugins use this for mapping
   */
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
  /**
   * Role names that can see/fill this field.
   *
   * WHY field-level access:
   * - Some fields only admins should fill
   * - User shouldn't even know certain fields exist
   * - Example: "discount_code" only for "sales" role
   */
  roles?: string[];

  // ═══ AGENT HINTS ═══
  /**
   * Context description for LLM extraction.
   *
   * WHY this matters:
   * - LLM needs context to correctly interpret user messages
   * - "Enter your order" could be order number or food order
   * - Description clarifies intent
   */
  description?: string;
  /**
   * Custom prompt template when agent asks for this field.
   *
   * WHY custom prompts:
   * - "What's your email?" vs "Where should we send the confirmation?"
   * - Allows personality and context-appropriate phrasing
   */
  askPrompt?: string;
  /**
   * Keywords to help LLM extraction.
   *
   * WHY extraction hints:
   * - LLM might not know domain-specific patterns
   * - "wallet address" helps identify Base58 strings as Solana addresses
   */
  extractHints?: string[];
  /**
   * Confidence threshold for automatic acceptance. Default: 0.8.
   *
   * WHY configurable threshold:
   * - High-stakes fields (payment amount) need high confidence
   * - Low-stakes fields (nickname) can be more lenient
   */
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
  /**
   * Child fields for object/array types.
   *
   * WHY nested fields:
   * - Complex data like address (street, city, zip)
   * - Agent can collect as one logical unit
   * - Stored as nested object
   */
  fields?: FormControl[];

  // ═══ EXTENSION ═══
  /**
   * Arbitrary metadata for plugins.
   *
   * WHY meta field:
   * - Plugins may need custom data we didn't anticipate
   * - Avoids modifying core types
   * - Example: trading plugin adds 'slippage_tolerance'
   */
  meta?: Record<string, JsonValue>;
}

// ============================================================================
// FORM DEFINITION - The container for controls
// ============================================================================

/**
 * UX options for the form.
 *
 * WHY form-level UX options:
 * - Different forms have different requirements
 * - Legal forms might disable undo
 * - Quick forms might disable autofill
 */
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

/**
 * Smart TTL configuration.
 *
 * WHY effort-based TTL:
 * - User spending 2 hours on a form deserves weeks of retention
 * - User who started and abandoned deserves quick cleanup
 * - Respects user effort while managing storage
 */
export interface FormDefinitionTTL {
  /** Minimum retention in days, even with no effort. Default: 14 */
  minDays?: number;
  /** Maximum retention in days, regardless of effort. Default: 90 */
  maxDays?: number;
  /**
   * Days added per minute of user effort. Default: 0.5.
   * Example: 10 min work = 5 extra days retention.
   */
  effortMultiplier?: number;
}

/**
 * Nudge configuration for stale sessions.
 *
 * WHY nudge system:
 * - Users forget about forms they started
 * - Gentle reminders increase completion rates
 * - But too many nudges are spammy
 */
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

/**
 * Hook configuration (task worker names).
 *
 * WHY hooks as task worker names:
 * - Consuming plugins define their own logic
 * - Hooks are async and can do anything
 * - Decouples form system from business logic
 */
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

/**
 * Localization for the form.
 */
export interface FormDefinitionI18n {
  name?: string;
  description?: string;
}

/**
 * FormDefinition - The form container
 *
 * Defines a complete form including all its fields, lifecycle settings,
 * permissions, and hooks for consuming plugins.
 *
 * WHY separate from controls:
 * - Form-level settings affect all controls
 * - Hooks need form context
 * - Permissions apply to entire form
 */
export interface FormDefinition {
  // ═══ IDENTITY ═══
  /** Unique identifier for this form definition */
  id: string;
  /** Human-readable name shown in UI and agent responses */
  name: string;
  /** Description of what this form collects */
  description?: string;
  /**
   * Schema version for migrations. Default: 1.
   *
   * WHY version:
   * - Forms evolve over time
   * - Old sessions might use old schema
   * - Version helps handle migrations
   */
  version?: number;

  // ═══ CONTROLS ═══
  /** Array of field definitions */
  controls: FormControl[];

  // ═══ LIFECYCLE ═══
  /**
   * Form status. Draft forms aren't startable.
   *
   * WHY status:
   * - Forms can be prepared but not yet active
   * - Deprecated forms shouldn't start new sessions
   * - Existing sessions on deprecated forms continue
   */
  status?: "draft" | "active" | "deprecated";

  // ═══ PERMISSIONS ═══
  /**
   * Roles that can start this form.
   *
   * WHY form-level roles:
   * - Some forms only for admins
   * - Prevents unauthorized data collection
   */
  roles?: string[];

  // ═══ BEHAVIOR ═══
  /**
   * Allow multiple submissions per user.
   *
   * WHY this flag:
   * - Registration forms: one per user
   * - Order forms: unlimited submissions
   * - Feedback forms: maybe one per session
   */
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
  /**
   * Enable debug logging for extraction.
   *
   * WHY debug flag:
   * - Extraction is LLM-based and can fail mysteriously
   * - Debug logs show LLM reasoning
   * - Off by default for performance
   */
  debug?: boolean;

  // ═══ I18N ═══
  i18n?: Record<string, FormDefinitionI18n>;

  // ═══ EXTENSION ═══
  meta?: Record<string, JsonValue>;
}

// ============================================================================
// FIELD STATE - Runtime state of a single field
// ============================================================================

/**
 * File attachment metadata.
 *
 * WHY separate from value:
 * - Files need special handling (storage, URLs)
 * - Metadata is safe to serialize, file content isn't
 * - URL might be temporary/signed
 */
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

/**
 * FieldState - Runtime state of a field
 *
 * Tracks the current value, validation status, confidence level,
 * and audit trail for a single field in an active form session.
 *
 * WHY this complexity:
 * - Agent extractions have confidence levels
 * - Users correct mistakes ("no, I meant...")
 * - Undo needs history
 * - Validation happens at extraction, not just submission
 */
export interface FieldState {
  // ═══ STATUS ═══
  /**
   * Current status of this field.
   *
   * WHY multiple statuses:
   * - 'empty': Not yet provided
   * - 'filled': Value accepted
   * - 'uncertain': LLM not confident, needs confirmation
   * - 'invalid': Value failed validation
   * - 'skipped': User explicitly skipped optional field
   * - 'pending': External type activated, waiting for confirmation
   */
  status: "empty" | "filled" | "uncertain" | "invalid" | "skipped" | "pending";

  // ═══ VALUE ═══
  /** The current value (undefined if empty/skipped) */
  value?: JsonValue;

  // ═══ CONFIDENCE ═══
  /**
   * LLM confidence in extraction. 0-1.
   *
   * WHY track confidence:
   * - Low confidence triggers confirmation
   * - High confidence allows auto-acceptance
   * - Useful for debugging extraction issues
   */
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
  /**
   * How this value was obtained.
   *
   * WHY track source:
   * - Autofilled values might need re-confirmation
   * - Corrections show user engagement
   * - Useful for analytics
   */
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
  /**
   * Subfield states for composite control types.
   *
   * WHY subFields:
   * - Composite types (address, payment) have multiple parts
   * - Each part has its own state (filled, uncertain, etc.)
   * - Parent field is "filled" when all required subfields are filled
   *
   * Keyed by subcontrol key (e.g., "amount", "currency" for payment).
   */
  subFields?: Record<string, FieldState>;

  // ═══ EXTERNAL TYPES ═══
  /**
   * State for external/async control types.
   *
   * WHY externalState:
   * - External types (payment, signature) have async lifecycle
   * - Need to track activation status, reference, instructions
   * - Separate from main status because field can be "pending" while
   *   we wait for external confirmation
   *
   * @see ExternalFieldState for full interface
   */
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

/**
 * History entry for undo functionality.
 *
 * WHY track history:
 * - "Undo" is natural in conversation ("wait, go back")
 * - Need to know what to restore
 * - Limited history prevents memory bloat
 */
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

/**
 * Effort tracking for smart TTL.
 *
 * WHY track effort:
 * - Forms abandoned quickly should expire quickly
 * - Forms worked on for hours deserve long retention
 * - Interaction count shows engagement even if time is short
 */
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

/**
 * FormSession - Active form state
 *
 * Represents an active form being filled by a user. This is the runtime
 * state that changes as the conversation progresses.
 *
 * WHY scoped to (entityId + roomId):
 * - Same user might fill different forms in different rooms
 * - Each room conversation has its own context
 * - User in Discord DM vs Telegram should have separate sessions
 *
 * WHY not just store values directly:
 * - Need to track status of each field
 * - Need confidence levels for confirmation
 * - Need history for undo
 * - Need metadata for analytics
 */
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
  /**
   * Session lifecycle status.
   *
   * WHY multiple statuses:
   * - 'active': Currently being filled
   * - 'ready': All required fields done, can submit
   * - 'submitted': Successfully submitted
   * - 'stashed': Saved for later
   * - 'cancelled': User abandoned
   * - 'expired': TTL exceeded
   */
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
  /**
   * Parent session ID for subforms.
   *
   * WHY parent reference:
   * - Complex forms might have nested sections
   * - Subform completion triggers parent update
   * - Not yet implemented but structure is ready
   */
  parentSessionId?: string;

  // ═══ CONTEXT ═══
  /**
   * Arbitrary context from consuming plugin.
   *
   * WHY context field:
   * - Consuming plugin might pass order ID, user tier, etc.
   * - Affects how form behaves or what values are valid
   * - Stored with session for hook access
   */
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

/**
 * FormSubmission - Completed form record
 *
 * The permanent record of a submitted form. This is what consuming
 * plugins use to create accounts, process orders, etc.
 *
 * WHY separate from session:
 * - Sessions are mutable, submissions are immutable
 * - Submissions don't need undo history, TTL, etc.
 * - Submissions are the "official record"
 */
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
  /**
   * Same values but keyed by dbbind.
   *
   * WHY mappedValues:
   * - Convenience for consuming plugins
   * - No need to look up dbbind for each field
   * - Direct database insertion ready
   */
  mappedValues?: Record<string, JsonValue>;
  /** File attachments keyed by control.key */
  files?: Record<string, FieldFile[]>;

  /** When the form was submitted */
  submittedAt: number;

  meta?: Record<string, JsonValue>;
}

// ============================================================================
// TYPE HANDLER - Custom type validation & formatting (Legacy)
// ============================================================================

/**
 * TypeHandler - Custom type behavior (Legacy interface)
 *
 * @deprecated Use ControlType instead for new code. TypeHandler is maintained
 * for backwards compatibility but ControlType offers more features.
 *
 * Allows registering custom field types with their own validation,
 * parsing, formatting, and extraction hints.
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
  /**
   * Description for LLM extraction.
   *
   * WHY extraction prompt:
   * - Helps LLM understand what to look for
   * - "a US phone number (10 digits)" vs just "phone"
   */
  extractionPrompt?: string;
}

// ============================================================================
// CONTROL TYPE - Unified widget/type registry
// ============================================================================

/**
 * ValidationResult - Standardized validation output
 *
 * WHY this structure:
 * - Consistent validation across all control types
 * - Error messages can be shown to users
 * - Simple boolean + optional error pattern
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * ActivationContext - Context passed to external control types
 *
 * WHY this exists:
 * - External types (payment, signature) need runtime access
 * - They need the session and control for context
 * - They need subfield values to know what to activate
 *
 * Example: Payment widget needs amount, currency, method from subcontrols
 * to generate the correct payment address and instructions.
 */
export interface ActivationContext {
  /** Runtime for accessing services */
  runtime: import("@elizaos/core").IAgentRuntime;
  /** The current form session */
  session: FormSession;
  /** The control being activated */
  control: FormControl;
  /** Filled subcontrol values, keyed by subcontrol key */
  subValues: Record<string, JsonValue>;
}

/**
 * ExternalActivation - Result of activating an external control type
 *
 * WHY this structure:
 * - Instructions tell user what to do ("Send 0.5 SOL to xyz...")
 * - Reference uniquely identifies this activation for matching events
 * - Address is optional but common (payment address, signing target)
 * - ExpiresAt allows time-limited activations
 *
 * The reference is critical: when a blockchain event comes in,
 * we match it to the pending activation via this reference.
 */
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

/**
 * ExternalFieldState - State tracking for external/async control types
 *
 * WHY this exists:
 * - External types have async lifecycles (pending → confirmed/failed)
 * - Need to store instructions for agent to communicate
 * - Need reference for matching events
 * - Need to track when things happened for debugging/TTL
 *
 * Stored within FieldState.externalState for fields using external types.
 */
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

/**
 * ControlType - Unified widget/type registry entry
 *
 * This is the evolution of TypeHandler into a full widget system.
 * ControlType handles three patterns:
 *
 * 1. **Simple types** (text, number, email)
 *    - Just validate/parse/format
 *    - No subcontrols, no activation
 *
 * 2. **Composite types** (address, payment setup)
 *    - Have subcontrols (getSubControls)
 *    - Parent field is "filled" when all subcontrols filled
 *    - No external activation
 *
 * 3. **External types** (payment, signature, file upload)
 *    - May have subcontrols
 *    - Have activate() for starting async process
 *    - Confirmation comes from external event
 *
 * WHY unified interface:
 * - Plugins register one type of thing (ControlType)
 * - FormService treats all types uniformly
 * - Progressive complexity: simple types just use validate()
 *
 * WHY builtin flag:
 * - Protects standard types from accidental override
 * - Allows intentional override with allowOverride option
 * - Logs warning when override happens
 *
 * Example registrations:
 *
 * ```typescript
 * // Simple type
 * formService.registerControlType({
 *   id: 'phone',
 *   builtin: false,
 *   validate: (v) => ({ valid: /^\+?[\d\s-]{10,}$/.test(String(v)) }),
 *   extractionPrompt: 'a phone number with country code',
 * });
 *
 * // Composite type
 * formService.registerControlType({
 *   id: 'address',
 *   getSubControls: () => [
 *     { key: 'street', type: 'text', label: 'Street', required: true },
 *     { key: 'city', type: 'text', label: 'City', required: true },
 *     { key: 'zip', type: 'text', label: 'ZIP', required: true },
 *   ],
 * });
 *
 * // External type (payment)
 * formService.registerControlType({
 *   id: 'payment',
 *   getSubControls: () => [
 *     { key: 'amount', type: 'number', label: 'Amount', required: true },
 *     { key: 'currency', type: 'select', label: 'Currency', required: true },
 *   ],
 *   activate: async (ctx) => {
 *     const paymentService = ctx.runtime.getService('PAYMENT');
 *     return paymentService.createPendingPayment(ctx.subValues);
 *   },
 *   deactivate: async (ctx) => {
 *     const ref = ctx.session.fields[ctx.control.key]?.externalState?.reference;
 *     if (ref) await paymentService.cancelPending(ref);
 *   },
 * });
 * ```
 */
export interface ControlType {
  /** Unique identifier for this control type */
  id: string;

  /**
   * If true, this is a built-in type that should warn on override.
   * Built-in types: text, number, email, boolean, select, date, file
   */
  builtin?: boolean;

  // ═══ SIMPLE TYPE METHODS ═══

  /**
   * Validate a value for this type.
   * Called during extraction and before submission.
   */
  validate?: (value: JsonValue, control: FormControl) => ValidationResult;

  /**
   * Parse string input to the appropriate type.
   * Called when processing extracted values.
   */
  parse?: (value: string) => JsonValue;

  /**
   * Format value for display to user.
   * Called when showing field values in context.
   */
  format?: (value: JsonValue) => string;

  /**
   * Description for LLM extraction.
   * Helps the LLM understand what to look for in user messages.
   */
  extractionPrompt?: string;

  // ═══ COMPOSITE TYPE METHODS ═══

  /**
   * Return subcontrols that must be filled before parent is complete.
   *
   * WHY runtime parameter:
   * - Subcontrols might depend on available services
   * - e.g., payment methods depend on what payment plugins are loaded
   *
   * Called by evaluator to understand the field structure.
   */
  getSubControls?: (
    control: FormControl,
    runtime: import("@elizaos/core").IAgentRuntime,
  ) => FormControl[];

  // ═══ EXTERNAL TYPE METHODS ═══

  /**
   * Activate the external process.
   *
   * Called when all subcontrols are filled (or immediately for
   * external types without subcontrols).
   *
   * Returns activation info including instructions and reference.
   * The reference is used to match incoming external events.
   */
  activate?: (context: ActivationContext) => Promise<ExternalActivation>;

  /**
   * Deactivate/cancel a pending external process.
   *
   * Called when user cancels form or field is reset.
   * Should clean up any pending listeners/watchers.
   */
  deactivate?: (context: ActivationContext) => Promise<void>;
}

// ============================================================================
// FORM WIDGET EVENTS - Events emitted by evaluator
// ============================================================================

/**
 * Form widget event types
 *
 * WHY events:
 * - Widgets don't parse messages, evaluator does
 * - Widgets react to these standardized events
 * - Single source of truth for extraction
 * - Plugins can listen for analytics/logging
 *
 * The evaluator emits these as it processes messages.
 */
export type FormWidgetEventType =
  | "FORM_FIELD_EXTRACTED" // Value extracted for any field
  | "FORM_SUBFIELD_UPDATED" // Subcontrol value updated
  | "FORM_SUBCONTROLS_FILLED" // All subcontrols of composite type filled
  | "FORM_EXTERNAL_ACTIVATED" // External type activated
  | "FORM_FIELD_CONFIRMED" // External field confirmed
  | "FORM_FIELD_CANCELLED"; // External field cancelled/expired

/**
 * Payload for FORM_FIELD_EXTRACTED event
 */
export interface FormFieldExtractedEvent {
  type: "FORM_FIELD_EXTRACTED";
  sessionId: string;
  field: string;
  value: JsonValue;
  confidence: number;
}

/**
 * Payload for FORM_SUBFIELD_UPDATED event
 */
export interface FormSubfieldUpdatedEvent {
  type: "FORM_SUBFIELD_UPDATED";
  sessionId: string;
  parentField: string;
  subField: string;
  value: JsonValue;
  confidence: number;
}

/**
 * Payload for FORM_SUBCONTROLS_FILLED event
 */
export interface FormSubcontrolsFilledEvent {
  type: "FORM_SUBCONTROLS_FILLED";
  sessionId: string;
  field: string;
  subValues: Record<string, JsonValue>;
}

/**
 * Payload for FORM_EXTERNAL_ACTIVATED event
 */
export interface FormExternalActivatedEvent {
  type: "FORM_EXTERNAL_ACTIVATED";
  sessionId: string;
  field: string;
  activation: ExternalActivation;
}

/**
 * Payload for FORM_FIELD_CONFIRMED event
 */
export interface FormFieldConfirmedEvent {
  type: "FORM_FIELD_CONFIRMED";
  sessionId: string;
  field: string;
  value: JsonValue;
  externalData?: Record<string, JsonValue>;
}

/**
 * Payload for FORM_FIELD_CANCELLED event
 */
export interface FormFieldCancelledEvent {
  type: "FORM_FIELD_CANCELLED";
  sessionId: string;
  field: string;
  reason: string;
}

/**
 * Union of all form widget events
 */
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

/**
 * Filled field summary for context.
 */
export interface FilledFieldSummary {
  key: string;
  label: string;
  /** Formatted value safe to show user (respects sensitive flag) */
  displayValue: string;
}

/**
 * Missing field summary for context.
 */
export interface MissingFieldSummary {
  key: string;
  label: string;
  description?: string;
  /** How agent should ask for this field */
  askPrompt?: string;
}

/**
 * Uncertain field summary for confirmation.
 */
export interface UncertainFieldSummary {
  key: string;
  label: string;
  /** The uncertain value */
  value: JsonValue;
  /** How confident the LLM was */
  confidence: number;
}

/**
 * FormContextState - Provider output for agent
 *
 * The context injected into the agent's state, giving it awareness
 * of the current form progress and what to do next.
 *
 * WHY this structure:
 * - Agent needs to know what's filled (for progress updates)
 * - Agent needs to know what's missing (to ask)
 * - Agent needs to know what's uncertain (to confirm)
 * - Agent needs suggested actions (what to do next)
 */
/**
 * Summary of a pending external field for agent context.
 */
export interface PendingExternalFieldSummary {
  /** Field key */
  key: string;
  /** Field label for display */
  label: string;
  /** Instructions for the user (e.g., "Send 0.5 SOL to xyz...") */
  instructions: string;
  /** Reference for matching (may be shown to user) */
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
  /** Number of stashed forms (for "you have saved forms" prompt) */
  stashedCount?: number;
  /** True if we asked "are you sure you want to cancel?" */
  pendingCancelConfirmation?: boolean;

  /**
   * External fields waiting for confirmation.
   *
   * WHY this exists:
   * - Agent needs to remind user about pending payments/signatures
   * - Shows instructions and reference for user to act on
   * - Allows agent to check "still waiting for your payment..."
   */
  pendingExternalFields: PendingExternalFieldSummary[];
}

// ============================================================================
// INTENT SYSTEM
// ============================================================================

/**
 * All supported user intents.
 *
 * WHY explicit intent types:
 * - Type safety for intent handling
 * - Clear documentation of what's supported
 * - Easy to add new intents
 */
export type FormIntent =
  // Lifecycle - affects session state
  | "fill_form" // Providing field values
  | "submit" // Ready to submit
  | "stash" // Save for later
  | "restore" // Resume saved form
  | "cancel" // Abandon form

  // UX Magic - helper actions
  | "undo" // Revert last change
  | "skip" // Skip optional field
  | "explain" // "Why do you need this?"
  | "example" // "Give me an example"
  | "progress" // "How far am I?"
  | "autofill" // "Use my usual values"

  // Fallback
  | "other"; // Unknown intent

/**
 * Extraction result for a single field.
 *
 * WHY this structure:
 * - Need value and confidence together
 * - Need to know if this is correcting a previous value
 * - Need reasoning for debugging
 */
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

/**
 * Combined intent and extraction result.
 *
 * WHY combined:
 * - Single LLM call extracts both intent and values
 * - Reduces latency
 * - Context helps with both
 */
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

/**
 * Default values for FormControl.
 *
 * WHY explicit defaults:
 * - Clear documentation of behavior
 * - Used by applyControlDefaults()
 * - Can be overridden per-control
 */
export const FORM_CONTROL_DEFAULTS = {
  type: "text",
  required: false,
  confirmThreshold: 0.8,
} as const;

/**
 * Default values for FormDefinition.
 *
 * WHY these specific defaults:
 * - 14 days min TTL: Long enough for user to return
 * - 90 days max TTL: Not forever, but generous
 * - 0.5 effort multiplier: 10 min work = 5 extra days
 * - 48h nudge: Not too aggressive
 * - 3 max nudges: Helpful but not spammy
 */
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

/**
 * Component type prefix for form sessions.
 *
 * WHY component-based storage:
 * - Components are ElizaOS's entity data storage
 * - Scoped to entity, can include room in type
 * - Automatic CRUD via runtime
 */
export const FORM_SESSION_COMPONENT = "form_session";

/**
 * Component type prefix for form submissions.
 */
export const FORM_SUBMISSION_COMPONENT = "form_submission";

/**
 * Component type prefix for autofill data.
 */
export const FORM_AUTOFILL_COMPONENT = "form_autofill";

/**
 * Autofill data stored per user per form.
 *
 * WHY store autofill:
 * - Users filling repeat forms want saved values
 * - Stored per user per form (not global)
 * - Updated on each submission
 */
export interface FormAutofillData {
  formId: string;
  values: Record<string, JsonValue>;
  updatedAt: number;
}
