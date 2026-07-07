/**
 * Canonical sensitive-request channel-adapter dispatch registry.
 *
 * This module owns the contract between the (Wave A) channel adapters
 * (Discord DM, owner-app inline, cloud / tunnel / public link, instruct-DM)
 * and the (Wave B) request-orchestration actions that will route a stored
 * request through the right channel.
 *
 * Type naming: the data shape passed to `deliver()` is `DispatchSensitiveRequest`
 * (NOT `SensitiveRequest`) to avoid collision with the legacy
 * `SensitiveRequest` exported from `sensitive-request-policy.ts`. Wave B
 * unifies them onto a single persistence record.
 */

import type { SensitiveRequestTunnelRouting } from "../sensitive-request-policy.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import { Service } from "../types/service.ts";

export const SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE =
	"SensitiveRequestDispatchRegistry";

export type DeliveryTarget =
	| "dm"
	| "owner_app_inline"
	| "owner_app_oauth"
	| "cloud_authenticated_link"
	| "tunnel_authenticated_link"
	| "public_link"
	| "instruct_dm_only";

export interface DeliveryResult {
	delivered: boolean;
	target: DeliveryTarget;
	url?: string;
	channelId?: string;
	formRendered?: boolean;
	/** epoch ms or ISO string — adapters may pass through whichever the source request used. */
	expiresAt?: number | string;
	error?: string;
}

/**
 * Payment-context discriminator used by the public-link adapter and (later)
 * by the unified payment surface in Wave B.
 */
export type SensitiveRequestPaymentContextDescriptor =
	| { kind: "any_payer" }
	| {
			kind: "verified_payer";
			scope?: "owner" | "owner_or_linked_identity";
	  }
	| { kind: "specific_payer"; payerIdentityId: string };

/**
 * Structural shape passed to adapter `deliver()`. Intentionally permissive so
 * it accepts either the new (epoch-ms persistence) record or the legacy
 * (ISO-string policy-resolved) record while Wave B unifies them. Adapters
 * that need richer typing cast at the boundary.
 */
export interface DispatchSensitiveRequest {
	id: string;
	kind: string;
	/** epoch ms (preferred) or ISO string for legacy / policy-resolved requests. */
	expiresAt?: number | string;
	/** Back-compat for callers that projected tunnel routing at the request root. */
	tunnel?: SensitiveRequestTunnelRouting;
	delivery?: {
		tunnel?: SensitiveRequestTunnelRouting;
		[k: string]: unknown;
	};
	[k: string]: unknown;
}

/**
 * Convenience alias for adapters that need to narrow on `paymentContext`.
 * The base shape is permissive so this type accepts both the new persistence
 * record and the legacy policy-resolved request.
 */
export interface SensitiveRequestWithPaymentContext
	extends DispatchSensitiveRequest {
	paymentContext?: SensitiveRequestPaymentContextDescriptor;
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface SensitiveRequestDeliveryAdapter {
	target: DeliveryTarget;
	/**
	 * Return false to signal this adapter cannot handle the channel
	 * (e.g., DM adapter when channel is a public group). Default: true.
	 */
	supportsChannel?(channelId: string | undefined, runtime: unknown): boolean;
	/**
	 * Deliver the request via the adapter's channel. Throwing is allowed; the
	 * caller wraps it.
	 */
	deliver(args: {
		request: DispatchSensitiveRequest;
		channelId?: string;
		runtime: unknown;
	}): Promise<DeliveryResult>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface SensitiveRequestDispatchRegistry {
	register(adapter: SensitiveRequestDeliveryAdapter): void;
	unregister(target: DeliveryTarget): void;
	/** Most-recently-registered adapter for `target` (back-compat). */
	get(target: DeliveryTarget): SensitiveRequestDeliveryAdapter | undefined;
	/**
	 * The adapter for `target` that supports `channelId` — the first whose
	 * `supportsChannel` does not return false, falling back to the most recent.
	 * This is what lets several connectors (Discord + Telegram) each register a
	 * "dm" adapter and have the right one selected per request.
	 */
	resolve?(
		target: DeliveryTarget,
		channelId: string | undefined,
		runtime: unknown,
	): SensitiveRequestDeliveryAdapter | undefined;
	list(): SensitiveRequestDeliveryAdapter[];
}

export function createSensitiveRequestDispatchRegistry(): SensitiveRequestDispatchRegistry {
	const adapters = new Map<DeliveryTarget, SensitiveRequestDeliveryAdapter[]>();
	const emptyAdapters: SensitiveRequestDeliveryAdapter[] = [];
	const listFor = (
		target: DeliveryTarget,
	): SensitiveRequestDeliveryAdapter[] => {
		const registered = adapters.get(target);
		return registered === undefined ? emptyAdapters : registered;
	};

	return {
		register(adapter) {
			const existing = adapters.get(adapter.target);
			const arr = existing === undefined ? [] : existing;
			// Idempotent: registering the same adapter object twice is a no-op.
			if (!arr.includes(adapter)) arr.push(adapter);
			adapters.set(adapter.target, arr);
		},
		unregister(target) {
			adapters.delete(target);
		},
		get(target) {
			const arr = listFor(target);
			return arr[arr.length - 1];
		},
		resolve(target, channelId, runtime) {
			const arr = listFor(target);
			for (const adapter of arr) {
				if (adapter.supportsChannel?.(channelId, runtime) !== false) {
					return adapter;
				}
			}
			return arr[arr.length - 1];
		},
		list() {
			return Array.from(adapters.values()).flat();
		},
	};
}

export class SensitiveRequestDispatchRegistryService
	extends Service
	implements SensitiveRequestDispatchRegistry
{
	static override serviceType = SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE;
	override capabilityDescription =
		"Sensitive-request delivery adapter registry";

	private readonly registry = createSensitiveRequestDispatchRegistry();

	static override async start(
		_runtime: IAgentRuntime,
	): Promise<SensitiveRequestDispatchRegistryService> {
		return new SensitiveRequestDispatchRegistryService();
	}

	override async stop(): Promise<void> {
		for (const adapter of this.registry.list()) {
			this.registry.unregister(adapter.target);
		}
	}

	register(adapter: SensitiveRequestDeliveryAdapter): void {
		this.registry.register(adapter);
	}

	unregister(target: DeliveryTarget): void {
		this.registry.unregister(target);
	}

	get(target: DeliveryTarget): SensitiveRequestDeliveryAdapter | undefined {
		return this.registry.get(target);
	}

	resolve(
		target: DeliveryTarget,
		channelId: string | undefined,
		runtime: unknown,
	): SensitiveRequestDeliveryAdapter | undefined {
		return this.registry.resolve?.(target, channelId, runtime);
	}

	list(): SensitiveRequestDeliveryAdapter[] {
		return this.registry.list();
	}
}
