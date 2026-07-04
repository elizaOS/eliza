/**
 * Public barrel for the subscription-auth capability: re-exports the
 * registry accessors and the `SubscriptionAuthProvider` /
 * `DiscoveredSubscriptionCredential` types that model-provider plugins use to
 * describe a vendor's subscription product to the generic host `auth/` layer.
 */
export {
	getSubscriptionAuthProvider,
	hasSubscriptionAuthProvider,
	listSubscriptionAuthProviders,
	registerSubscriptionAuthProvider,
	resetSubscriptionAuthProviders,
} from "./registry.ts";
export type {
	DiscoveredSubscriptionCredential,
	SubscriptionAuthProvider,
} from "./types.ts";
