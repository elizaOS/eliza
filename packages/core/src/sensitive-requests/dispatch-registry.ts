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

export type DeliveryTarget =
	| "dm"
	| "owner_app_inline"
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
	get(target: DeliveryTarget): SensitiveRequestDeliveryAdapter | undefined;
	list(): SensitiveRequestDeliveryAdapter[];
}

export function createSensitiveRequestDispatchRegistry(): SensitiveRequestDispatchRegistry {
	const adapters = new Map<DeliveryTarget, SensitiveRequestDeliveryAdapter>();

	return {
		register(adapter) {
			adapters.set(adapter.target, adapter);
		},
		unregister(target) {
			adapters.delete(target);
		},
		get(target) {
			return adapters.get(target);
		},
		list() {
			return Array.from(adapters.values());
		},
	};
}
