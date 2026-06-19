/**
 * Plugin Activator Service
 *
 * Enables dynamic plugin activation when required secrets become available.
 * Plugins can register for activation with their secret requirements,
 * and will be activated automatically once all secrets are present.
 */

import { logger } from "../../../logger.ts";
import {
	type IAgentRuntime,
	type Plugin,
	Service,
	type ServiceTypeName,
} from "../../../types/index.ts";
import type {
	PendingPluginActivation,
	PluginActivatorConfig,
	PluginRequirementStatus,
	PluginSecretRequirement,
	SecretContext,
} from "../types.ts";
import { SECRETS_SERVICE_TYPE, type SecretsService } from "./secrets.ts";

/**
 * Service type identifier
 */
export const PLUGIN_ACTIVATOR_SERVICE_TYPE =
	"PLUGIN_ACTIVATOR" as ServiceTypeName;

/**
 * Default configuration
 */
const DEFAULT_CONFIG: PluginActivatorConfig = {
	enableAutoActivation: true,
	pollingIntervalMs: 5000,
	maxWaitMs: 0, // 0 = wait forever
};

/**
 * Extended Plugin interface with secret requirements
 */
export interface PluginWithSecrets extends Plugin {
	/** Required secrets for this plugin to function */
	requiredSecrets?: Record<string, PluginSecretRequirement>;

	/** Called when all required secrets become available */
	onSecretsReady?: (runtime: IAgentRuntime) => Promise<void>;

	/** Called when a required secret changes */
	onSecretChanged?: (
		key: string,
		value: string | null,
		runtime: IAgentRuntime,
	) => Promise<void>;
}

/**
 * Registered plugin with callbacks for secret change notifications.
 */
interface RegisteredPlugin {
	/** Plugin instance */
	plugin: PluginWithSecrets;
	/** Secret keys this plugin depends on */
	secretKeys: string[];
	/** Activation callback */
	activationCallback?: () => Promise<void>;
}

/**
 * Plugin Activator Service
 *
 * Manages the lifecycle of plugins that depend on secrets:
 * - Tracks plugins waiting for secrets
 * - Automatically activates plugins when requirements are met
 * - Notifies plugins when their secrets change
 * - Supports onSecretsReady and onSecretChanged callbacks
 */
export class PluginActivatorService extends Service {
	static serviceType: ServiceTypeName = PLUGIN_ACTIVATOR_SERVICE_TYPE;
	capabilityDescription =
		"Activate plugins dynamically when their required secrets become available";

	private activatorConfig: PluginActivatorConfig;
	private secretsService: SecretsService | null = null;
	private pendingPlugins: Map<string, PendingPluginActivation> = new Map();
	private activatedPlugins: Set<string> = new Set();
	private pluginSecretMapping: Map<string, Set<string>> = new Map();
	private pollingInterval: ReturnType<typeof setInterval> | null = null;
	private unsubscribeSecretChanges: (() => void) | null = null;

	/** Registered plugins with their callbacks */
	private registeredPlugins: Map<string, RegisteredPlugin> = new Map();

	/** Listeners for secrets ready events */
	private secretsReadyListeners: Map<
		string,
		Array<(runtime: IAgentRuntime) => Promise<void>>
	> = new Map();

	/** Listeners for secret changed events */
	private secretChangedListeners: Map<
		string,
		Array<
			(
				key: string,
				value: string | null,
				runtime: IAgentRuntime,
			) => Promise<void>
		>
	> = new Map();

	constructor(
		runtime?: IAgentRuntime,
		config?: Partial<PluginActivatorConfig>,
	) {
		super(runtime);
		this.activatorConfig = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Start the service
	 */
	static async start(
		runtime: IAgentRuntime,
		config?: Partial<PluginActivatorConfig>,
	): Promise<PluginActivatorService> {
		const service = new PluginActivatorService(runtime, config);
		await service.initialize();
		return service;
	}

	/**
	 * Initialize the service
	 */
	private async initialize(): Promise<void> {
		logger.info("[PluginActivator] Initializing");

		// Try to get secrets service synchronously first
		this.secretsService =
			this.runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE);

		if (!this.secretsService) {
			// Service not ready yet - use getServiceLoadPromise if available
			await this.waitForSecretsService();
		} else {
			this.bindToSecretsService();
		}

		// Start polling if auto-activation enabled
		if (
			this.activatorConfig.enableAutoActivation &&
			this.activatorConfig.pollingIntervalMs > 0
		) {
			this.startPolling();
		}

		logger.info("[PluginActivator] Initialized");
	}

	/**
	 * Wait for SecretsService to become available using runtime's service load promise
	 */
	private async waitForSecretsService(): Promise<void> {
		// Prefer runtime's promise-based service loading if available
		if (typeof this.runtime.getServiceLoadPromise === "function") {
			try {
				logger.debug(
					"[PluginActivator] Awaiting SecretsService via getServiceLoadPromise",
				);
				const service =
					await this.runtime.getServiceLoadPromise(SECRETS_SERVICE_TYPE);
				if (service) {
					this.secretsService = service as SecretsService;
					logger.info("[PluginActivator] SecretsService now available");
					this.bindToSecretsService();
					return;
				}
			} catch (err) {
				logger.debug(
					`[PluginActivator] getServiceLoadPromise failed: ${err instanceof Error ? err.message : err}`,
				);
			}
		}

		// Fallback to polling if getServiceLoadPromise not available or failed
		const maxAttempts = 20;
		const delayMs = 250;

		for (let i = 0; i < maxAttempts; i++) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));

			this.secretsService =
				this.runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE);

			if (this.secretsService) {
				logger.info("[PluginActivator] SecretsService now available");
				this.bindToSecretsService();
				return;
			}
		}

		logger.warn(
			"[PluginActivator] SecretsService not available after waiting, activation will be limited",
		);
	}

	/**
	 * Bind to the SecretsService for change notifications
	 */
	private bindToSecretsService(): void {
		if (!this.secretsService || this.unsubscribeSecretChanges) return;

		this.unsubscribeSecretChanges = this.secretsService.onAnySecretChanged(
			async (key, value, context) => {
				await this.onSecretChanged(key, value, context);
			},
		);
	}

	/**
	 * Stop the service
	 */
	async stop(): Promise<void> {
		logger.info("[PluginActivator] Stopping");

		if (this.pollingInterval) {
			clearInterval(this.pollingInterval);
			this.pollingInterval = null;
		}

		if (this.unsubscribeSecretChanges) {
			this.unsubscribeSecretChanges();
			this.unsubscribeSecretChanges = null;
		}

		this.pendingPlugins.clear();
		this.activatedPlugins.clear();
		this.pluginSecretMapping.clear();
		this.registeredPlugins.clear();
		this.secretsReadyListeners.clear();
		this.secretChangedListeners.clear();

		logger.info("[PluginActivator] Stopped");
	}

	// ============================================================================
	// Plugin Registration
	// ============================================================================

	/**
	 * Register a plugin for activation when secrets are ready
	 */
	async registerPlugin(
		plugin: PluginWithSecrets,
		activationCallback?: () => Promise<void>,
	): Promise<boolean> {
		const pluginId = plugin.name;

		if (this.activatedPlugins.has(pluginId)) {
			logger.debug(`[PluginActivator] Plugin ${pluginId} already activated`);
			return true;
		}

		// Collect all secret keys this plugin depends on
		const allSecretKeys = plugin.requiredSecrets
			? Object.keys(plugin.requiredSecrets)
			: [];

		// Store plugin reference for later notifications
		this.registeredPlugins.set(pluginId, {
			plugin,
			secretKeys: allSecretKeys,
			activationCallback,
		});

		if (
			!plugin.requiredSecrets ||
			Object.keys(plugin.requiredSecrets).length === 0
		) {
			// No secrets required, activate immediately
			logger.info(
				`[PluginActivator] Plugin ${pluginId} has no secret requirements, activating`,
			);
			return this.activatePlugin(pluginId, plugin, activationCallback);
		}

		// Check current secret status
		const status = await this.checkPluginRequirements(plugin);

		if (status.ready) {
			// All secrets available, activate now
			logger.info(
				`[PluginActivator] Plugin ${pluginId} has all required secrets, activating`,
			);
			return this.activatePlugin(pluginId, plugin, activationCallback);
		}

		// Queue for later activation
		logger.info(
			`[PluginActivator] Plugin ${pluginId} queued, waiting for: ${status.missingRequired.join(", ")}`,
		);

		const requiredSecrets = Object.entries(plugin.requiredSecrets)
			.filter(([_, req]) => req.required)
			.map(([key]) => key);

		this.pendingPlugins.set(pluginId, {
			pluginId,
			requiredSecrets,
			callback: async () => {
				await this.activatePlugin(pluginId, plugin, activationCallback);
			},
			registeredAt: Date.now(),
		});

		// Track which secrets this plugin needs
		for (const secretKey of requiredSecrets) {
			const plugins = this.pluginSecretMapping.get(secretKey) ?? new Set();
			plugins.add(pluginId);
			this.pluginSecretMapping.set(secretKey, plugins);
		}

		return false;
	}

	/**
	 * Unregister a pending plugin
	 */
	unregisterPlugin(pluginId: string): boolean {
		const pending = this.pendingPlugins.get(pluginId);
		if (!pending) {
			return false;
		}

		// Remove from secret mapping
		for (const secretKey of pending.requiredSecrets) {
			const plugins = this.pluginSecretMapping.get(secretKey);
			if (plugins) {
				plugins.delete(pluginId);
				if (plugins.size === 0) {
					this.pluginSecretMapping.delete(secretKey);
				}
			}
		}

		this.pendingPlugins.delete(pluginId);
		logger.info(`[PluginActivator] Unregistered plugin ${pluginId}`);
		return true;
	}

	// ============================================================================
	// Plugin Activation
	// ============================================================================

	/**
	 * Activate a plugin
	 */
	private async activatePlugin(
		pluginId: string,
		plugin: PluginWithSecrets,
		callback?: () => Promise<void>,
	): Promise<boolean> {
		try {
			// Call the activation callback
			if (callback) {
				await callback();
			}

			// Call plugin's onSecretsReady if defined
			if (plugin.onSecretsReady) {
				await plugin.onSecretsReady(this.runtime);
			}

			this.activatedPlugins.add(pluginId);
			this.pendingPlugins.delete(pluginId);

			logger.info(`[PluginActivator] Activated plugin ${pluginId}`);

			// Notify secretsReady listeners
			const listeners = this.secretsReadyListeners.get(pluginId);
			if (listeners) {
				for (const listener of listeners) {
					try {
						await listener(this.runtime);
					} catch (error) {
						const errorMessage =
							error instanceof Error ? error.message : String(error);
						logger.error(
							`[PluginActivator] onSecretsReady listener failed for ${pluginId}: ${errorMessage}`,
						);
					}
				}
			}

			return true;
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				`[PluginActivator] Failed to activate plugin ${pluginId}: ${errorMessage}`,
			);
			return false;
		}
	}

	/**
	 * Check requirements for a plugin
	 */
	async checkPluginRequirements(
		plugin: PluginWithSecrets,
	): Promise<PluginRequirementStatus> {
		if (!plugin.requiredSecrets) {
			return {
				pluginId: plugin.name,
				ready: true,
				missingRequired: [],
				missingOptional: [],
				invalid: [],
				message: "No secrets required",
			};
		}

		if (!this.secretsService) {
			// Can't check without secrets service
			const required = Object.entries(plugin.requiredSecrets)
				.filter(([_, req]) => req.required)
				.map(([key]) => key);

			return {
				pluginId: plugin.name,
				ready: required.length === 0,
				missingRequired: required,
				missingOptional: [],
				invalid: [],
				message: "SecretsService not available",
			};
		}

		const result = await this.secretsService.checkPluginRequirements(
			plugin.name,
			plugin.requiredSecrets,
		);
		return {
			pluginId: plugin.name,
			...result,
			message: result.ready
				? "All secrets available"
				: `Missing: ${result.missingRequired.join(", ")}`,
		};
	}

	/**
	 * Get status of all registered plugins
	 */
	getPluginStatuses(): Map<
		string,
		{ pending: boolean; activated: boolean; missingSecrets: string[] }
	> {
		const statuses = new Map<
			string,
			{ pending: boolean; activated: boolean; missingSecrets: string[] }
		>();

		for (const [pluginId, pending] of this.pendingPlugins) {
			statuses.set(pluginId, {
				pending: true,
				activated: false,
				missingSecrets: pending.requiredSecrets,
			});
		}

		for (const pluginId of this.activatedPlugins) {
			statuses.set(pluginId, {
				pending: false,
				activated: true,
				missingSecrets: [],
			});
		}

		return statuses;
	}

	// ============================================================================
	// Secret Change Handling
	// ============================================================================

	/**
	 * Handle secret change event
	 */
	private async onSecretChanged(
		key: string,
		value: string | null,
		context: SecretContext,
	): Promise<void> {
		// Only process global secret changes for plugin activation
		if (context.level !== "global") {
			return;
		}

		// Check if any pending plugins need this secret
		const affectedPlugins = this.pluginSecretMapping.get(key);

		// First, check pending plugins for activation
		if (affectedPlugins && affectedPlugins.size > 0) {
			logger.debug(
				`[PluginActivator] Secret ${key} changed, checking ${affectedPlugins.size} plugins`,
			);

			for (const pluginId of affectedPlugins) {
				const pending = this.pendingPlugins.get(pluginId);
				if (!pending) {
					continue;
				}

				// Check if all required secrets are now available
				const missing = await this.getMissingSecrets(pending.requiredSecrets);
				if (missing.length === 0) {
					logger.info(
						`[PluginActivator] All secrets available for ${pluginId}, activating`,
					);
					await pending.callback();
				}
			}
		}

		// Notify all activated plugins that depend on this secret
		await this.notifySecretChanged(key, value);
	}

	/**
	 * Notify activated plugins about a secret change.
	 */
	private async notifySecretChanged(
		key: string,
		value: string | null,
	): Promise<void> {
		// Notify registered plugins with onSecretChanged callback
		for (const [pluginId, registered] of this.registeredPlugins) {
			// Only notify if this plugin depends on this secret
			if (!registered.secretKeys.includes(key)) {
				continue;
			}

			// Only notify activated plugins
			if (!this.activatedPlugins.has(pluginId)) {
				continue;
			}

			const plugin = registered.plugin;
			if (plugin.onSecretChanged) {
				try {
					logger.debug(
						`[PluginActivator] Notifying plugin ${pluginId} of secret change: ${key}`,
					);
					await plugin.onSecretChanged(key, value, this.runtime);
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					logger.error(
						`[PluginActivator] Plugin ${pluginId} onSecretChanged failed: ${errorMessage}`,
					);
				}
			}
		}

		// Notify registered listeners for this specific secret
		const specificListeners = this.secretChangedListeners.get(key);
		if (specificListeners) {
			for (const listener of specificListeners) {
				try {
					await listener(key, value, this.runtime);
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					logger.error(
						`[PluginActivator] Secret changed listener failed for ${key}: ${errorMessage}`,
					);
				}
			}
		}

		// Notify global listeners (subscribed to all secrets)
		const globalListeners = this.secretChangedListeners.get("__ALL_SECRETS__");
		if (globalListeners) {
			for (const listener of globalListeners) {
				try {
					await listener(key, value, this.runtime);
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					logger.error(
						`[PluginActivator] Global secret changed listener failed for ${key}: ${errorMessage}`,
					);
				}
			}
		}
	}

	/**
	 * Get missing secrets from a list
	 */
	private async getMissingSecrets(keys: string[]): Promise<string[]> {
		if (!this.secretsService) {
			return keys;
		}

		return this.secretsService.getMissingSecrets(keys, "global");
	}

	// ============================================================================
	// Polling
	// ============================================================================

	/**
	 * Start polling for pending plugins
	 */
	private startPolling(): void {
		if (this.pollingInterval) {
			return;
		}

		this.pollingInterval = setInterval(async () => {
			await this.checkPendingPlugins();
		}, this.activatorConfig.pollingIntervalMs);

		logger.debug(
			`[PluginActivator] Started polling every ${this.activatorConfig.pollingIntervalMs}ms`,
		);
	}

	/**
	 * Check all pending plugins
	 */
	private async checkPendingPlugins(): Promise<void> {
		if (this.pendingPlugins.size === 0) {
			return;
		}

		const now = Date.now();

		for (const [pluginId, pending] of this.pendingPlugins) {
			// Check timeout
			if (this.activatorConfig.maxWaitMs > 0) {
				const elapsed = now - pending.registeredAt;
				if (elapsed > this.activatorConfig.maxWaitMs) {
					logger.warn(
						`[PluginActivator] Plugin ${pluginId} timed out waiting for secrets`,
					);
					this.unregisterPlugin(pluginId);
					continue;
				}
			}

			// Check if secrets are now available
			const missing = await this.getMissingSecrets(pending.requiredSecrets);
			if (missing.length === 0) {
				logger.info(`[PluginActivator] Secrets now available for ${pluginId}`);
				await pending.callback();
			}
		}
	}

	// ============================================================================
	// Utility Methods
	// ============================================================================

	/**
	 * Get list of pending plugins
	 */
	getPendingPlugins(): string[] {
		return Array.from(this.pendingPlugins.keys());
	}

	/**
	 * Get list of activated plugins
	 */
	getActivatedPlugins(): string[] {
		return Array.from(this.activatedPlugins);
	}

	/**
	 * Check if a plugin is pending
	 */
	isPending(pluginId: string): boolean {
		return this.pendingPlugins.has(pluginId);
	}

	/**
	 * Check if a plugin is activated
	 */
	isActivated(pluginId: string): boolean {
		return this.activatedPlugins.has(pluginId);
	}

	/**
	 * Get secrets required by pending plugins
	 */
	getRequiredSecrets(): Set<string> {
		const secrets = new Set<string>();
		for (const pending of this.pendingPlugins.values()) {
			for (const key of pending.requiredSecrets) {
				secrets.add(key);
			}
		}
		return secrets;
	}

	/**
	 * Get plugins waiting for a specific secret
	 */
	getPluginsWaitingFor(secretKey: string): string[] {
		const plugins = this.pluginSecretMapping.get(secretKey);
		return plugins ? Array.from(plugins) : [];
	}

	// ============================================================================
	// Callback Subscription Methods
	// ============================================================================

	/**
	 * Subscribe to secrets ready event for a specific plugin.
	 * The callback will be invoked when all required secrets for the plugin become available.
	 *
	 * @param pluginId - Plugin identifier to subscribe to
	 * @param callback - Callback to invoke when secrets are ready
	 * @returns Unsubscribe function
	 */
	onSecretsReady(
		pluginId: string,
		callback: (runtime: IAgentRuntime) => Promise<void>,
	): () => void {
		const listeners = this.secretsReadyListeners.get(pluginId) ?? [];
		listeners.push(callback);
		this.secretsReadyListeners.set(pluginId, listeners);

		// If already activated, call immediately
		if (this.activatedPlugins.has(pluginId)) {
			callback(this.runtime).catch((error) => {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				logger.error(
					`[PluginActivator] onSecretsReady callback failed for ${pluginId}: ${errorMessage}`,
				);
			});
		}

		return () => {
			const currentListeners = this.secretsReadyListeners.get(pluginId);
			if (currentListeners) {
				const index = currentListeners.indexOf(callback);
				if (index !== -1) {
					currentListeners.splice(index, 1);
				}
				if (currentListeners.length === 0) {
					this.secretsReadyListeners.delete(pluginId);
				}
			}
		};
	}

	/**
	 * Subscribe to secret changed events for a specific secret key.
	 * The callback will be invoked whenever the specified secret changes.
	 *
	 * @param secretKey - Secret key to subscribe to
	 * @param callback - Callback to invoke when secret changes
	 * @returns Unsubscribe function
	 */
	onSecretChangedKey(
		secretKey: string,
		callback: (
			key: string,
			value: string | null,
			runtime: IAgentRuntime,
		) => Promise<void>,
	): () => void {
		const listeners = this.secretChangedListeners.get(secretKey) ?? [];
		listeners.push(callback);
		this.secretChangedListeners.set(secretKey, listeners);

		return () => {
			const currentListeners = this.secretChangedListeners.get(secretKey);
			if (currentListeners) {
				const index = currentListeners.indexOf(callback);
				if (index !== -1) {
					currentListeners.splice(index, 1);
				}
				if (currentListeners.length === 0) {
					this.secretChangedListeners.delete(secretKey);
				}
			}
		};
	}

	/**
	 * Subscribe to all secret changed events.
	 * The callback will be invoked whenever any secret changes.
	 *
	 * @param callback - Callback to invoke when any secret changes
	 * @returns Unsubscribe function
	 */
	onAnySecretChanged(
		callback: (
			key: string,
			value: string | null,
			runtime: IAgentRuntime,
		) => Promise<void>,
	): () => void {
		// Use a special key for global listeners
		const globalKey = "__ALL_SECRETS__";
		const listeners = this.secretChangedListeners.get(globalKey) ?? [];
		listeners.push(callback);
		this.secretChangedListeners.set(globalKey, listeners);

		return () => {
			const currentListeners = this.secretChangedListeners.get(globalKey);
			if (currentListeners) {
				const index = currentListeners.indexOf(callback);
				if (index !== -1) {
					currentListeners.splice(index, 1);
				}
				if (currentListeners.length === 0) {
					this.secretChangedListeners.delete(globalKey);
				}
			}
		};
	}

	/**
	 * Get the registered plugin by ID.
	 */
	getRegisteredPlugin(pluginId: string): PluginWithSecrets | undefined {
		return this.registeredPlugins.get(pluginId)?.plugin;
	}

	/**
	 * Get all registered plugin IDs.
	 */
	getRegisteredPluginIds(): string[] {
		return Array.from(this.registeredPlugins.keys());
	}

	/**
	 * Check if a plugin has the onSecretChanged callback.
	 */
	hasSecretChangedCallback(pluginId: string): boolean {
		const registered = this.registeredPlugins.get(pluginId);
		return registered?.plugin.onSecretChanged !== undefined;
	}

	/**
	 * Check if a plugin has the onSecretsReady callback.
	 */
	hasSecretsReadyCallback(pluginId: string): boolean {
		const registered = this.registeredPlugins.get(pluginId);
		return registered?.plugin.onSecretsReady !== undefined;
	}
}
