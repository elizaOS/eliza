/**
 * Canonical runtime service for filesystem, terminal, git, model, and plugin capabilities.
 * An ordered strategy table selects each dispatcher; an explicit fallback handles uncovered capabilities.
 */

import {
	CAPABILITY_ROUTER_SERVICE_TYPE,
	type CapabilityAvailability,
	type CapabilityEnvironment,
	type ElizaCapabilityRouter,
	type FileCapability,
	type GitCapability,
	type LocalModelCapability,
	type RemotePluginCapability,
	type TerminalCapability,
	UnavailableCapabilityRouter,
} from "../capabilities/index.js";
import type { IAgentRuntime } from "../types/runtime.js";
import { Service } from "../types/service.js";

/**
 * Routing strategy interface. Each strategy decides how to dispatch a
 * capability invocation: locally (via a remote-mode plugin running in the
 * host process) or remotely (via HTTPS to a capability-host container,
 * an e2b sandbox, or another paired user device).
 *
 * Strategies are an internal implementation detail of
 * {@link RuntimeCapabilityService}; external callers only see the
 * {@link ElizaCapabilityRouter} surface.
 */
export interface CapabilityStrategy {
	readonly id: string;
	readonly environment: CapabilityEnvironment;
	availability(): Promise<CapabilityAvailability>;
	readonly fs?: FileCapability;
	readonly pty?: TerminalCapability;
	readonly git?: GitCapability;
	readonly model?: LocalModelCapability;
	readonly plugin?: RemotePluginCapability;
}

/** Options for constructing a {@link RuntimeCapabilityService}. */
export interface RuntimeCapabilityServiceOptions {
	/**
	 * Strategy table keyed by capability dispatcher. The first matching
	 * strategy wins per capability invocation.
	 */
	strategies?: CapabilityStrategy[];
	/**
	 * Fallback router used when no strategy matches. Defaults to
	 * {@link UnavailableCapabilityRouter}.
	 */
	fallback?: ElizaCapabilityRouter;
}

/**
 * Service that owns the {@link CAPABILITY_ROUTER_SERVICE_TYPE} slot and exposes
 * the common router surface independently of where a capability executes.
 *
 * Usage:
 *
 * ```ts
 * const svc = runtime.getService(CAPABILITY_ROUTER_SERVICE_TYPE);
 * if (svc) {
 *   const availability = await svc.availability();
 *   // capability dispatch via svc.fs / .pty / .git / .model / .plugin
 * }
 * ```
 */
export class RuntimeCapabilityService
	extends Service
	implements ElizaCapabilityRouter
{
	static override serviceType = CAPABILITY_ROUTER_SERVICE_TYPE;

	override capabilityDescription =
		"Unified capability router. Dispatches fs / pty / git / model / plugin " +
		"invocations to whichever strategy (local remote-mode plugin or remote " +
		"HTTPS endpoint) is configured for the capability.";

	private strategies: CapabilityStrategy[];
	private fallback: ElizaCapabilityRouter;

	constructor(
		runtime: IAgentRuntime,
		options: RuntimeCapabilityServiceOptions = {},
	) {
		super(runtime);
		this.strategies = options.strategies ?? [];
		this.fallback =
			options.fallback ??
			new UnavailableCapabilityRouter(
				"unknown",
				"no-capability-strategy-configured",
			);
	}

	static override async start(
		runtime: IAgentRuntime,
	): Promise<RuntimeCapabilityService> {
		return new RuntimeCapabilityService(runtime);
	}

	override async stop(): Promise<void> {
		// Strategies own their own teardown; the service itself holds no resources.
	}

	get environment(): CapabilityEnvironment {
		return this.strategies[0]?.environment ?? this.fallback.environment;
	}

	async availability(): Promise<CapabilityAvailability> {
		return this.fallback.availability();
	}

	get fs(): FileCapability {
		return this.pickStrategy("fs")?.fs ?? this.fallback.fs;
	}

	get pty(): TerminalCapability {
		return this.pickStrategy("pty")?.pty ?? this.fallback.pty;
	}

	get git(): GitCapability {
		return this.pickStrategy("git")?.git ?? this.fallback.git;
	}

	get model(): LocalModelCapability {
		return this.pickStrategy("model")?.model ?? this.fallback.model;
	}

	get plugin(): RemotePluginCapability {
		return this.pickStrategy("plugin")?.plugin ?? this.fallback.plugin;
	}

	/**
	 * Replace the strategy table at runtime. Used when the host discovers a
	 * new capability-providing remote plugin and registers it as a strategy.
	 */
	setStrategies(strategies: CapabilityStrategy[]): void {
		this.strategies = strategies;
	}

	/** Replace the fallback router. */
	setFallback(fallback: ElizaCapabilityRouter): void {
		this.fallback = fallback;
	}

	private pickStrategy(
		capability: "fs" | "pty" | "git" | "model" | "plugin",
	): CapabilityStrategy | undefined {
		for (const strategy of this.strategies) {
			if (strategy[capability]) return strategy;
		}
		return undefined;
	}
}
