/**
 * Plugin-config feature — runtime contract.
 *
 * The plugin-config atomic actions never touch plugin manifests, secrets, or
 * the runtime plugin registry directly. They resolve a single
 * `PluginConfigClient` service through `runtime.getService(...)`. Sibling
 * waves (manifest scanning, manifest registry, secrets service adapter)
 * provide the concrete implementation; this slice only defines the shape.
 *
 * Mirrors the payments / secrets slice layout — same service-resolution
 * pattern, same opt-in plugin (not auto-enabled).
 */
import type { DispatchSensitiveRequest } from "../../sensitive-requests/dispatch-registry.ts";

/**
 * One key from a plugin's manifest `requiredSecrets[]` /
 * `optionalSecrets[]`. The `optional` flag mirrors the manifest split — the
 * key itself is a single env-var-shaped string.
 */
export interface PluginConfigKey {
	key: string;
	optional: boolean;
}

/**
 * Result of probing a plugin's configuration manifest against the current
 * secrets store / env.
 */
export interface PluginConfigRequirements {
	pluginName: string;
	required: string[];
	optional: string[];
	present: string[];
	missing: string[];
}

/**
 * Result of a single status poll.
 */
export interface PluginConfigStatus {
	pluginName: string;
	ready: boolean;
	missing: string[];
}

/**
 * Outcome of dispatching the per-key collection form. One entry per missing
 * required key, in the same order they were resolved.
 */
export interface PluginConfigDeliveryEntry {
	key: string;
	requestId: string;
	delivered: boolean;
	target?: string;
	error?: string;
}

export interface PluginConfigDeliveryResult {
	pluginName: string;
	entries: PluginConfigDeliveryEntry[];
}

/**
 * Outcome of an activation attempt. `activated=false, reason="not_ready"`
 * means the probe still reports missing keys; `activated=false,
 * reason="already_registered"` means the plugin was already live.
 */
export interface PluginActivationResult {
	pluginName: string;
	activated: boolean;
	reason?: "not_ready" | "already_registered" | "no_manifest" | "error";
	missing?: string[];
	error?: string;
}

/**
 * Cloud / app-level adapter that knows how to:
 *   1. Read a plugin's declared required/optional secrets from its manifest.
 *   2. Check which of those are currently present in the secrets store /
 *      runtime env.
 *   3. Mint a sensitive-request envelope per missing key (so the DELIVER
 *      action can route it through the dispatch registry).
 *   4. Register a plugin with the runtime once it is ready.
 *
 * Resolved via `runtime.getService(PLUGIN_CONFIG_CLIENT_SERVICE)`. The
 * provider may live in `@elizaos/cloud` or in the app-core runtime — this
 * slice does not import it.
 */
export interface PluginConfigClient {
	/**
	 * Return the declared required+optional config keys for a plugin and the
	 * subset currently satisfied. `null` if no manifest is registered for the
	 * given plugin name.
	 */
	getRequirements(pluginName: string): Promise<PluginConfigRequirements | null>;

	/**
	 * Build a sensitive-request envelope for a single missing key. The caller
	 * is responsible for dispatching it through the
	 * `SensitiveRequestDispatchRegistry`. Returning `null` means the client
	 * declined to mint a request (e.g. unknown key, manifest gone).
	 */
	createConfigRequest(input: {
		pluginName: string;
		key: string;
		reason?: string;
	}): Promise<DispatchSensitiveRequest | null>;

	/**
	 * Quick "is this plugin ready" check — typically a re-probe that returns
	 * the still-missing set.
	 */
	getStatus(pluginName: string): Promise<PluginConfigStatus | null>;

	/**
	 * Register the plugin with the runtime (load + init). Returning `false`
	 * means the plugin could not be activated (already registered, no
	 * manifest, etc.). The caller decides what to surface to the user.
	 */
	activate(pluginName: string): Promise<boolean>;
}

/**
 * Service name constant — used by every action's
 * `runtime.getService(...)` call so the cloud / app-core adapter can register
 * itself under a stable key.
 */
export const PLUGIN_CONFIG_CLIENT_SERVICE = "PluginConfigClient";

/**
 * Event emitted by the ACTIVATE action when a plugin transitions from
 * not-registered to registered. Carried as a string-typed event because the
 * core `EventPayloadMap` does not enumerate plugin-config events.
 */
export const PLUGIN_ACTIVATED_EVENT = "PluginActivated";

export interface PluginActivatedEventPayload {
	pluginName: string;
	at: number;
}
