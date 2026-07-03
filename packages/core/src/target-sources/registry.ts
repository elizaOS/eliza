/**
 * Connector target-source registry.
 *
 * A `TargetSource` enumerates a connector's addressable destinations (Discord
 * guild channels, Slack channels, Gmail recipients, …) as structured
 * `TargetGroup`s so the workflow clarification UI can offer quick-pick targets
 * instead of asking the user to paste raw IDs.
 *
 * Connector plugins register their source into the runtime-scoped
 * `TargetSourceRegistryService` at load; the host's connector-target-catalog
 * drains `list()` at call time. Per-connector enumeration (REST clients, tokens,
 * caches) stays inside the owning plugin — the host iterates registered sources
 * with no per-platform branches, so a new connector needs no host edit.
 *
 * Mirrors the `SensitiveRequestDispatchRegistry` pattern: the contract + factory
 * live here in `@elizaos/core` (so connector plugins depend only on core, never
 * on the host), and a `Service` subclass is provided by basic-capabilities
 * before plugin init so registrations at load always find the registry.
 */

import type { IAgentRuntime } from "../types/runtime.ts";
import { Service } from "../types/service.ts";

export const CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE =
	"ConnectorTargetSourceRegistry";

/** A single addressable destination within a group. */
export interface TargetEntry {
	id: string;
	name: string;
	kind: "channel" | "recipient" | "chat";
}

/** A server / workspace / chat-collection and its addressable targets. */
export interface TargetGroup {
	/** Connector platform: 'discord', 'slack', 'telegram', 'gmail', … */
	platform: string;
	/** Server / workspace / chat-collection id (e.g. Discord guild id). */
	groupId: string;
	/** Human-readable group name (e.g. "Cozy Devs"). */
	groupName: string;
	targets: TargetEntry[];
}

/** Warning-only logger a source may use during enumeration. */
export interface TargetSourceLogger {
	warn?: (obj: Record<string, unknown>, msg?: string) => void;
}

/**
 * Host-supplied seams passed to `enumerate`. The host owns config access and
 * the injectable `fetch` / clock; the source owns its platform REST client and
 * any per-token cache.
 */
export interface TargetEnumerationContext {
	/** Restrict to a single group within the platform (e.g. one guild). */
	groupId?: string;
	/**
	 * Opaque accessor for the host connector config. A source narrows it to the
	 * slot it owns (e.g. `connectors.discord.token`). Handing the source the host
	 * config verbatim keeps token resolution identical to the pre-registry
	 * catalog.
	 */
	getConfig?: () => unknown;
	/** Test/injection seam — the source defaults to global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Test/injection seam — the source defaults to `Date.now`. */
	now?: () => number;
	/** Warning-only logger. */
	logger?: TargetSourceLogger;
}

/** A connector's addressable-target enumerator. */
export interface TargetSource {
	/** Connector platform key this source enumerates: 'discord', 'slack', … */
	readonly platform: string;
	/**
	 * Enumerate this connector's target groups. Degrades to `[]` on missing
	 * config or network failure — never throws.
	 */
	enumerate(ctx: TargetEnumerationContext): Promise<TargetGroup[]>;
}

/** Registry of connector target sources, keyed by platform. */
export interface TargetSourceRegistry {
	register(source: TargetSource): void;
	unregister(platform: string): void;
	get(platform: string): TargetSource | undefined;
	list(): TargetSource[];
}

export function createTargetSourceRegistry(): TargetSourceRegistry {
	const sources = new Map<string, TargetSource>();
	return {
		register(source) {
			sources.set(source.platform, source);
		},
		unregister(platform) {
			sources.delete(platform);
		},
		get(platform) {
			return sources.get(platform);
		},
		list() {
			return Array.from(sources.values());
		},
	};
}

/**
 * Runtime service wrapping a {@link TargetSourceRegistry}. Registered by
 * basic-capabilities so it exists before connector plugins initialize.
 */
export class TargetSourceRegistryService
	extends Service
	implements TargetSourceRegistry
{
	static override serviceType = CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE;
	override capabilityDescription =
		"Connector target-source registry: enumerates addressable connector destinations for workflow target selection.";

	private readonly registry = createTargetSourceRegistry();

	static override async start(
		_runtime: IAgentRuntime,
	): Promise<TargetSourceRegistryService> {
		return new TargetSourceRegistryService();
	}

	override async stop(): Promise<void> {
		for (const source of this.registry.list()) {
			this.registry.unregister(source.platform);
		}
	}

	register(source: TargetSource): void {
		this.registry.register(source);
	}

	unregister(platform: string): void {
		this.registry.unregister(platform);
	}

	get(platform: string): TargetSource | undefined {
		return this.registry.get(platform);
	}

	list(): TargetSource[] {
		return this.registry.list();
	}
}
