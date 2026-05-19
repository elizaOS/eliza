/**
 * Hook Service Type Definitions
 *
 * Provides the type system for the hook service that consolidates
 * event-driven hooks across the Eliza agent runtime.
 */

import { type EventPayload, EventType } from "./events";
import type { Service } from "./service";

// ============================================================================
// Hook Source and Priority Types
// ============================================================================

/**
 * Identifies the origin of a hook registration.
 */
export type HookSource =
	| "bundled" // Built-in hooks from @elizaos/core
	| "managed" // User-installed hooks (~/.elizaos/hooks/)
	| "workspace" // Project-local hooks (./hooks/)
	| "plugin" // Plugin-registered hooks
	| "runtime"; // Programmatic registration via API

/**
 * Hook priority. Higher values run first. Default is 0.
 * Hooks with the same priority run in FIFO order (registration time).
 */
export type HookPriority = number;

/**
 * Default hook priority (FIFO ordering)
 */
export const DEFAULT_HOOK_PRIORITY: HookPriority = 0;

// ============================================================================
// Hook Requirements (Eligibility)
// ============================================================================

/**
 * Specifies requirements that must be met for a hook to be eligible.
 * If any requirement is not met, the hook will not be triggered.
 */
export interface HookRequirements {
	/** Operating systems where this hook is valid (e.g., ["darwin", "linux"]) */
	os?: string[];
	/** Binary executables that must be available in PATH (all required) */
	bins?: string[];
	/** Binary executables where at least one must be available */
	anyBins?: string[];
	/** Environment variables that must be set */
	env?: string[];
	/** Configuration paths that must be truthy (e.g., ["workspace.dir"]) */
	config?: string[];
}

/**
 * Result of an eligibility check for a hook.
 */
export interface HookEligibilityResult {
	/** Whether the hook is eligible to run */
	eligible: boolean;
	/** Reasons why the hook is not eligible (if applicable) */
	reasons?: string[];
}

// ============================================================================
// Hook Metadata and Registration
// ============================================================================

/**
 * Metadata describing a registered hook.
 */
export interface HookMetadata {
	/** Display name of the hook */
	name: string;
	/** Human-readable description */
	description?: string;
	/** Source/origin of the hook */
	source: HookSource;
	/** Plugin ID if registered by a plugin */
	pluginId?: string;
	/** Event types this hook listens to */
	events: EventType[];
	/** Execution priority (higher runs first) */
	priority: HookPriority;
	/** Whether the hook is currently enabled */
	enabled: boolean;
	/** If true, bypass eligibility checks (except explicit disable) */
	always?: boolean;
	/** Requirements for this hook to be eligible */
	requires?: HookRequirements;
}

/**
 * Handler function for hook events.
 * Receives the event payload and can modify it (for modifying hooks).
 */
export type HookHandler<T extends EventPayload = EventPayload> = (
	payload: T,
) => Promise<void> | void;

/**
 * A registered hook with its handler and metadata.
 */
export interface HookRegistration {
	/** Unique identifier for this registration */
	id: string;
	/** Hook metadata */
	metadata: HookMetadata;
	/** The handler function */
	handler: HookHandler;
	/** Unix timestamp when this hook was registered */
	registeredAt: number;
}

/**
 * Options for registering a hook.
 */
export interface HookRegistrationOptions {
	/** Display name of the hook */
	name: string;
	/** Human-readable description */
	description?: string;
	/** Source/origin of the hook (defaults to "runtime") */
	source?: HookSource;
	/** Plugin ID if registered by a plugin */
	pluginId?: string;
	/** Execution priority (defaults to 0, higher runs first) */
	priority?: HookPriority;
	/** If true, bypass eligibility checks */
	always?: boolean;
	/** Requirements for this hook to be eligible */
	requires?: HookRequirements;
}

// ============================================================================
// Hook Snapshot (Introspection)
// ============================================================================

/**
 * Summary of a registered hook for introspection.
 */
export interface HookSummary {
	/** Hook name */
	name: string;
	/** Event types this hook listens to */
	events: EventType[];
	/** Source/origin of the hook */
	source: HookSource;
	/** Whether the hook is enabled */
	enabled: boolean;
	/** Plugin ID if from a plugin */
	pluginId?: string;
	/** Priority */
	priority: HookPriority;
}

/**
 * Snapshot of all registered hooks at a point in time.
 */
export interface HookSnapshot {
	/** List of hook summaries */
	hooks: HookSummary[];
	/** Snapshot version (increments on each change) */
	version: number;
	/** Timestamp when snapshot was taken */
	timestamp: number;
}

// ============================================================================
// Directory-based Hook Loading
// ============================================================================

/**
 * Parsed frontmatter from a HOOK.md file.
 */
export interface HookFrontmatter {
	/** Hook name */
	name?: string;
	/** Hook description */
	description?: string;
	/** Events this hook handles */
	events?: string[];
	/** Export name in handler module (default: "default") */
	export?: string;
	/** Operating systems supported */
	os?: string[];
	/** If true, bypass eligibility checks */
	always?: boolean;
	/** Requirements */
	requires?: {
		bins?: string[];
		anyBins?: string[];
		env?: string[];
		config?: string[];
	};
}

/**
 * A hook discovered from a directory.
 */
export interface DiscoveredHook {
	/** Hook name */
	name: string;
	/** Hook description */
	description: string;
	/** Source type */
	source: HookSource;
	/** Plugin ID if from plugin */
	pluginId?: string;
	/** Path to HOOK.md */
	filePath: string;
	/** Base directory containing the hook */
	baseDir: string;
	/** Path to handler module (handler.ts/js) */
	handlerPath: string;
	/** Parsed frontmatter */
	frontmatter: HookFrontmatter;
}

/**
 * Result of loading hooks from a directory.
 */
export interface HookLoadResult {
	/** Hooks that were successfully loaded and registered */
	loaded: string[];
	/** Hooks that were skipped (eligibility, disabled, etc.) */
	skipped: Array<{ name: string; reason: string }>;
	/** Errors encountered during loading */
	errors: Array<{ name: string; error: string }>;
}

// ============================================================================
// Hook Service Interface
// ============================================================================

/**
 * The HookService provides a interface for registering, managing,
 * and executing hooks across the Eliza agent runtime.
 *
 * Hooks are event-driven handlers that can respond to various lifecycle
 * events in the agent system. The service integrates with the runtime's
 * event system to dispatch hook handlers when events are emitted.
 *
 * @example
 * ```typescript
 * // Get the hook service
 * const hookService = runtime.getService<IHookService>(ServiceType.HOOKS);
 *
 * // Register a hook programmatically
 * const hookId = hookService.register(
 *   [EventType.HOOK_COMMAND_NEW],
 *   async (payload) => {
 *     payload.messages.push("Session started!");
 *   },
 *   { name: "welcome-hook", description: "Welcomes users on new session" }
 * );
 *
 * // Load hooks from a directory
 * const result = await hookService.registerFromDirectory(
 *   "./hooks",
 *   "workspace"
 * );
 *
 * // Introspect registered hooks
 * const snapshot = hookService.getSnapshot();
 * console.log(`${snapshot.hooks.length} hooks registered`);
 * ```
 */
export interface IHookService extends Service {
	// ========================================================================
	// Registration
	// ========================================================================

	/**
	 * Register a hook handler for one or more event types.
	 *
	 * @param events - Event type(s) to listen for
	 * @param handler - Handler function to call when event fires
	 * @param options - Registration options (name, priority, etc.)
	 * @returns Unique hook registration ID
	 */
	register(
		events: EventType | EventType[],
		handler: HookHandler,
		options: HookRegistrationOptions,
	): string;

	/**
	 * Unregister a previously registered hook.
	 *
	 * @param hookId - The hook registration ID returned from register()
	 * @returns true if hook was found and removed, false otherwise
	 */
	unregister(hookId: string): boolean;

	/**
	 * Load and register hooks from a directory.
	 *
	 * Scans the directory for subdirectories containing HOOK.md files,
	 * validates eligibility, and registers eligible hooks.
	 *
	 * @param dir - Directory path to scan for hooks
	 * @param source - Source type for these hooks
	 * @param options - Additional options (plugin ID, etc.)
	 * @returns Result of the loading operation
	 */
	registerFromDirectory(
		dir: string,
		source: HookSource,
		options?: { pluginId?: string },
	): Promise<HookLoadResult>;

	// ========================================================================
	// Introspection
	// ========================================================================

	/**
	 * Get a snapshot of all registered hooks.
	 *
	 * @returns Snapshot with hook summaries and metadata
	 */
	getSnapshot(): HookSnapshot;

	/**
	 * Get all hooks registered for a specific event type.
	 *
	 * @param event - Event type to query
	 * @returns Array of hook registrations for that event
	 */
	getHooksByEvent(event: EventType): HookRegistration[];

	/**
	 * Get a specific hook registration by ID.
	 *
	 * @param hookId - Hook registration ID
	 * @returns The registration or undefined if not found
	 */
	getHook(hookId: string): HookRegistration | undefined;

	/**
	 * Get all registered hooks.
	 *
	 * @returns Array of all hook registrations
	 */
	getAllHooks(): HookRegistration[];

	// ========================================================================
	// Configuration
	// ========================================================================

	/**
	 * Enable or disable a hook.
	 *
	 * @param hookId - Hook registration ID
	 * @param enabled - Whether the hook should be enabled
	 */
	setEnabled(hookId: string, enabled: boolean): void;

	/**
	 * Update a hook's priority.
	 *
	 * @param hookId - Hook registration ID
	 * @param priority - New priority value
	 */
	setPriority(hookId: string, priority: HookPriority): void;

	// ========================================================================
	// Eligibility
	// ========================================================================

	/**
	 * Check if a hook is eligible to run based on its requirements.
	 *
	 * @param hookId - Hook registration ID
	 * @returns Eligibility result with reasons if not eligible
	 */
	checkEligibility(hookId: string): HookEligibilityResult;

	/**
	 * Check if a hook meets specific requirements.
	 *
	 * @param requirements - Requirements to check
	 * @param config - Optional configuration to check against
	 * @returns Eligibility result
	 */
	checkRequirements(
		requirements: HookRequirements,
		config?: Record<string, unknown>,
	): HookEligibilityResult;
}

// ============================================================================
// Legacy Compatibility Types (for Otto migration)
// ============================================================================

/**
 * Legacy hook event type mapping for Otto compatibility.
 * Maps old event strings to new EventType enum values.
 */
export const LEGACY_EVENT_MAP: Record<string, EventType> = {
	"command:new": EventType.HOOK_COMMAND_NEW,
	"command:reset": EventType.HOOK_COMMAND_RESET,
	"command:stop": EventType.HOOK_COMMAND_STOP,
	"session:start": EventType.HOOK_SESSION_START,
	"session:end": EventType.HOOK_SESSION_END,
	"agent:basic-capabilities": EventType.HOOK_AGENT_BASIC_CAPABILITIES,
	"gateway:startup": EventType.HOOK_GATEWAY_START,
	"gateway:stop": EventType.HOOK_GATEWAY_STOP,
	// Plugin lifecycle hooks
	before_agent_start: EventType.HOOK_AGENT_START,
	agent_end: EventType.HOOK_AGENT_END,
	before_compaction: EventType.HOOK_COMPACTION_BEFORE,
	after_compaction: EventType.HOOK_COMPACTION_AFTER,
	message_sending: EventType.HOOK_MESSAGE_SENDING,
	before_tool_call: EventType.HOOK_TOOL_BEFORE,
	after_tool_call: EventType.HOOK_TOOL_AFTER,
	tool_result_persist: EventType.HOOK_TOOL_PERSIST,
	session_start: EventType.HOOK_SESSION_START,
	session_end: EventType.HOOK_SESSION_END,
	gateway_start: EventType.HOOK_GATEWAY_START,
	gateway_stop: EventType.HOOK_GATEWAY_STOP,
};

/**
 * Maps legacy event type strings to the canonical type.
 * Handles both old format ("command:new") and new format ("HOOK_COMMAND_NEW").
 *
 * @param legacyEvent - Legacy event string
 * @returns The canonical EventType or undefined if not mapped
 */
export function mapLegacyEvent(legacyEvent: string): EventType | undefined {
	// Check if it's already a valid EventType
	if (Object.values(EventType).includes(legacyEvent as EventType)) {
		return legacyEvent as EventType;
	}
	// Check legacy mapping
	return LEGACY_EVENT_MAP[legacyEvent];
}

/**
 * Maps an array of legacy event strings to EventType values.
 * Filters out any events that cannot be mapped.
 *
 * @param legacyEvents - Array of legacy event strings
 * @returns Array of mapped EventType values
 */
export function mapLegacyEvents(legacyEvents: string[]): EventType[] {
	const mapped: EventType[] = [];
	for (const event of legacyEvents) {
		const mappedEvent = mapLegacyEvent(event);
		if (mappedEvent) {
			mapped.push(mappedEvent);
		}
	}
	return mapped;
}
