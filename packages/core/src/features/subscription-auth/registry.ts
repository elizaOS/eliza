/**
 * Registry for {@link SubscriptionAuthProvider} descriptors.
 *
 * Model-provider plugins (or host built-ins) register their vendor's
 * subscription product here; the host `auth/` layer drains it generically.
 * Registration is idempotent per id (last registration wins) so a plugin can
 * override a host built-in without an ordering constraint.
 *
 * @module features/subscription-auth
 */

import type { SubscriptionAuthProvider } from "./types.ts";

const registry = new Map<string, SubscriptionAuthProvider>();

/**
 * Register (or replace) the subscription-auth descriptor for a vendor id.
 * Idempotent: re-registering the same id overwrites the prior descriptor.
 */
export function registerSubscriptionAuthProvider(
	provider: SubscriptionAuthProvider,
): void {
	registry.set(provider.id, provider);
}

/** Look up the registered descriptor for a vendor id, or `undefined`. */
export function getSubscriptionAuthProvider(
	id: string,
): SubscriptionAuthProvider | undefined {
	return registry.get(id);
}

/** All registered descriptors, in registration order. */
export function listSubscriptionAuthProviders(): SubscriptionAuthProvider[] {
	return [...registry.values()];
}

/** True when a descriptor is registered for the vendor id. */
export function hasSubscriptionAuthProvider(id: string): boolean {
	return registry.has(id);
}

/**
 * Remove all registered descriptors. Test-only — lets a suite start from a
 * clean registry without reloading the module.
 */
export function resetSubscriptionAuthProviders(): void {
	registry.clear();
}
