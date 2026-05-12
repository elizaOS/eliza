/**
 * HookService - Hook Management Service
 *
 * Provides centralized hook registration, management, and execution for the
 * Eliza agent runtime. Integrates with the runtime event system to dispatch
 * hooks when events are emitted.
 *
 * Key features:
 * - registry for all hook sources (bundled, workspace, plugin, runtime)
 * - Priority-based execution with FIFO ordering for same priority
 * - Eligibility checking based on OS, binaries, env vars, and config
 * - Directory-based hook discovery and loading
 * - Integration with runtime event system
 */

import type { EventPayload, EventType } from "../types/events";
import type {
	HookEligibilityResult,
	HookFrontmatter,
	HookHandler,
	HookLoadResult,
	HookMetadata,
	HookPriority,
	HookRegistration,
	HookRegistrationOptions,
	HookRequirements,
	HookSnapshot,
	HookSource,
	HookSummary,
	IHookService,
} from "../types/hook";
import { DEFAULT_HOOK_PRIORITY } from "../types/hook";
import type { IAgentRuntime } from "../types/runtime";
import { Service, ServiceType } from "../types/service";

function hasBinary(_bin: string): boolean {
	return false;
}

/**
 * Get the current platform name
 */
function getCurrentPlatform(): string {
	return typeof process !== "undefined" && process.platform
		? process.platform
		: "unknown";
}

/**
 * Parse YAML-like frontmatter from HOOK.md content
 */
function _parseFrontmatter(content: string): HookFrontmatter {
	const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) {
		return {};
	}

	const frontmatterText = frontmatterMatch[1];
	const result: HookFrontmatter = {};

	// Parse simple YAML-like key-value pairs
	const lines = frontmatterText.split("\n");
	let currentKey: string | null = null;
	let currentArray: string[] | null = null;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Check for array item
		if (trimmed.startsWith("- ") && currentKey && currentArray !== null) {
			currentArray.push(trimmed.slice(2).trim());
			continue;
		}

		// Check for key-value pair
		const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
		if (kvMatch) {
			const [, key, value] = kvMatch;

			// Save previous array if any
			if (currentKey && currentArray !== null) {
				(result as Record<string, unknown>)[currentKey] = currentArray;
			}

			currentKey = key;

			if (value) {
				// Simple value
				currentArray = null;
				if (value === "true") {
					(result as Record<string, unknown>)[key] = true;
				} else if (value === "false") {
					(result as Record<string, unknown>)[key] = false;
				} else if (/^\d+$/.test(value)) {
					(result as Record<string, unknown>)[key] = parseInt(value, 10);
				} else {
					(result as Record<string, unknown>)[key] = value.replace(
						/^["']|["']$/g,
						"",
					);
				}
			} else {
				// Start of array
				currentArray = [];
			}
		}
	}

	// Save last array if any
	if (currentKey && currentArray !== null) {
		(result as Record<string, unknown>)[currentKey] = currentArray;
	}

	return result;
}

/**
 * HookService implementation
 */
export class HookService extends Service implements IHookService {
	static serviceType = ServiceType.HOOKS;
	capabilityDescription = "Hook registration and execution";

	/** Hook registry keyed by ID */
	private registry = new Map<string, HookRegistration>();

	/** Index of hook IDs by event type for fast lookup */
	private eventIndex = new Map<EventType, Set<string>>();

	/** Counter for generating unique hook IDs */
	private idCounter = 0;

	/** Version counter for snapshots */
	private snapshotVersion = 0;

	/** Configuration for eligibility checks */
	private hookConfig: Record<string, unknown> = {};

	/**
	 * Start the hook service
	 */
	static async start(runtime: IAgentRuntime): Promise<HookService> {
		const service = new HookService(runtime);

		// Register event handlers for all hook event types
		// The service will intercept these and dispatch to registered hooks
		service.setupEventInterceptors();

		return service;
	}

	/**
	 * Stop the hook service
	 */
	async stop(): Promise<void> {
		this.registry.clear();
		this.eventIndex.clear();
	}

	/**
	 * Set up event interceptors to dispatch to hooks
	 */
	private setupEventInterceptors(): void {
		// Get all HOOK_* event types
		const hookEventTypes = Object.values(
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			require("../types/events").EventType,
		).filter(
			(e) => typeof e === "string" && (e as string).startsWith("HOOK_"),
		) as EventType[];

		for (const eventType of hookEventTypes) {
			this.runtime.registerEvent(eventType, async (payload: EventPayload) => {
				await this.dispatchToHooks(eventType, payload);
			});
		}
	}

	/**
	 * Dispatch an event to all registered hooks
	 */
	private async dispatchToHooks(
		eventType: EventType,
		payload: EventPayload,
	): Promise<void> {
		const hookIds = this.eventIndex.get(eventType);
		if (!hookIds || hookIds.size === 0) {
			return;
		}

		// Get registrations and sort by priority (descending), then registration time (ascending)
		const registrations = Array.from(hookIds)
			.map((id) => this.registry.get(id))
			.filter((reg): reg is HookRegistration => reg !== undefined)
			.filter((reg) => reg.metadata.enabled)
			.filter((reg) => {
				const eligibility = this.checkEligibilityInternal(reg);
				return eligibility.eligible;
			})
			.sort((a, b) => {
				if (b.metadata.priority !== a.metadata.priority) {
					return b.metadata.priority - a.metadata.priority;
				}
				return a.registeredAt - b.registeredAt;
			});

		// Execute hooks sequentially (allows payload modification, maintains order)
		for (const registration of registrations) {
			await registration.handler(payload);
		}
	}

	/**
	 * Check eligibility for a registration (internal)
	 */
	private checkEligibilityInternal(
		registration: HookRegistration,
	): HookEligibilityResult {
		const { metadata } = registration;

		// Always-enabled hooks bypass checks
		if (metadata.always) {
			return { eligible: true };
		}

		const requirements = metadata.requires;
		if (!requirements) {
			return { eligible: true };
		}

		return this.checkRequirements(requirements, this.hookConfig);
	}

	// ========================================================================
	// Registration
	// ========================================================================

	register(
		events: EventType | EventType[],
		handler: HookHandler,
		options: HookRegistrationOptions,
	): string {
		const eventArray = Array.isArray(events) ? events : [events];

		// Generate unique ID
		const id = `hook_${++this.idCounter}_${options.name.replace(/\s+/g, "_").toLowerCase()}`;

		// Create metadata
		const metadata: HookMetadata = {
			name: options.name,
			description: options.description,
			source: options.source ?? "runtime",
			pluginId: options.pluginId,
			events: eventArray,
			priority: options.priority ?? DEFAULT_HOOK_PRIORITY,
			enabled: true,
			always: options.always,
			requires: options.requires,
		};

		// Create registration
		const registration: HookRegistration = {
			id,
			metadata,
			handler,
			registeredAt: Date.now(),
		};

		// Store in registry
		this.registry.set(id, registration);

		// Update event index
		for (const event of eventArray) {
			if (!this.eventIndex.has(event)) {
				this.eventIndex.set(event, new Set());
			}
			this.eventIndex.get(event)?.add(id);
		}

		// Increment snapshot version
		this.snapshotVersion++;

		this.runtime.logger.debug(
			{
				src: "hook-service",
				hookId: id,
				events: eventArray,
				priority: metadata.priority,
			},
			`Registered hook: ${options.name}`,
		);

		return id;
	}

	unregister(hookId: string): boolean {
		const registration = this.registry.get(hookId);
		if (!registration) {
			return false;
		}

		// Remove from event index
		for (const event of registration.metadata.events) {
			const hookIds = this.eventIndex.get(event);
			if (hookIds) {
				hookIds.delete(hookId);
				if (hookIds.size === 0) {
					this.eventIndex.delete(event);
				}
			}
		}

		// Remove from registry
		this.registry.delete(hookId);

		// Increment snapshot version
		this.snapshotVersion++;

		this.runtime.logger.debug(
			{ src: "hook-service", hookId },
			`Unregistered hook: ${registration.metadata.name}`,
		);

		return true;
	}

	async registerFromDirectory(
		_dir: string,
		_source: HookSource,
		_options?: { pluginId?: string },
	): Promise<HookLoadResult> {
		throw new Error(
			"registerFromDirectory is not supported in the environment-agnostic core.",
		);
	}

	// ========================================================================
	// Introspection
	// ========================================================================

	getSnapshot(): HookSnapshot {
		const hooks: HookSummary[] = Array.from(this.registry.values()).map(
			(reg) => ({
				name: reg.metadata.name,
				events: reg.metadata.events,
				source: reg.metadata.source,
				enabled: reg.metadata.enabled,
				pluginId: reg.metadata.pluginId,
				priority: reg.metadata.priority,
			}),
		);

		return {
			hooks,
			version: this.snapshotVersion,
			timestamp: Date.now(),
		};
	}

	getHooksByEvent(event: EventType): HookRegistration[] {
		const hookIds = this.eventIndex.get(event);
		if (!hookIds) {
			return [];
		}

		return Array.from(hookIds)
			.map((id) => this.registry.get(id))
			.filter((reg): reg is HookRegistration => reg !== undefined);
	}

	getHook(hookId: string): HookRegistration | undefined {
		return this.registry.get(hookId);
	}

	getAllHooks(): HookRegistration[] {
		return Array.from(this.registry.values());
	}

	// ========================================================================
	// Configuration
	// ========================================================================

	setEnabled(hookId: string, enabled: boolean): void {
		const registration = this.registry.get(hookId);
		if (registration) {
			registration.metadata.enabled = enabled;
			this.snapshotVersion++;
		}
	}

	setPriority(hookId: string, priority: HookPriority): void {
		const registration = this.registry.get(hookId);
		if (registration) {
			registration.metadata.priority = priority;
			this.snapshotVersion++;
		}
	}

	/**
	 * Set configuration for eligibility checks
	 */
	setConfig(config: Record<string, unknown>): void {
		this.hookConfig = config;
	}

	// ========================================================================
	// Eligibility
	// ========================================================================

	checkEligibility(hookId: string): HookEligibilityResult {
		const registration = this.registry.get(hookId);
		if (!registration) {
			return { eligible: false, reasons: ["Hook not found"] };
		}
		return this.checkEligibilityInternal(registration);
	}

	checkRequirements(
		requirements: HookRequirements,
		config?: Record<string, unknown>,
	): HookEligibilityResult {
		const reasons: string[] = [];

		// Check OS requirements
		if (requirements.os && requirements.os.length > 0) {
			const currentPlatform = getCurrentPlatform();
			if (!requirements.os.includes(currentPlatform)) {
				reasons.push(
					`OS '${currentPlatform}' not in allowed list: ${requirements.os.join(", ")}`,
				);
			}
		}

		// Check required binaries (all must be present)
		if (requirements.bins && requirements.bins.length > 0) {
			for (const bin of requirements.bins) {
				if (!hasBinary(bin)) {
					reasons.push(`Required binary '${bin}' not found`);
				}
			}
		}

		// Check anyBins (at least one must be present)
		if (requirements.anyBins && requirements.anyBins.length > 0) {
			const hasAny = requirements.anyBins.some((bin) => hasBinary(bin));
			if (!hasAny) {
				reasons.push(
					`None of required binaries found: ${requirements.anyBins.join(", ")}`,
				);
			}
		}

		// Check environment variables
		if (requirements.env && requirements.env.length > 0) {
			for (const envVar of requirements.env) {
				if (!process.env[envVar]) {
					reasons.push(`Required environment variable '${envVar}' not set`);
				}
			}
		}

		// Check config paths
		if (requirements.config && requirements.config.length > 0 && config) {
			for (const configPath of requirements.config) {
				const value = this.resolveConfigPath(config, configPath);
				if (!this.isTruthy(value)) {
					reasons.push(`Required config path '${configPath}' is not truthy`);
				}
			}
		}

		return {
			eligible: reasons.length === 0,
			reasons: reasons.length > 0 ? reasons : undefined,
		};
	}

	/**
	 * Resolve a dot-separated config path
	 */
	private resolveConfigPath(
		config: Record<string, unknown>,
		pathStr: string,
	): unknown {
		const parts = pathStr.split(".").filter(Boolean);
		let current: unknown = config;

		for (const part of parts) {
			if (typeof current !== "object" || current === null) {
				return undefined;
			}
			current = (current as Record<string, unknown>)[part];
		}

		return current;
	}

	/**
	 * Check if a value is truthy
	 */
	private isTruthy(value: unknown): boolean {
		if (value === undefined || value === null) {
			return false;
		}
		if (typeof value === "boolean") {
			return value;
		}
		if (typeof value === "number") {
			return value !== 0;
		}
		if (typeof value === "string") {
			return value.trim().length > 0;
		}
		return true;
	}
}

/**
 * Create and return the HookService class for registration
 */
export const HookServiceClass = HookService;
