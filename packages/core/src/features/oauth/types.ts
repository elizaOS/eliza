/**
 * OAuth atomic action types (Wave C).
 *
 * These types describe the runtime contract between the per-action OAuth
 * handlers (CREATE_OAUTH_INTENT, DELIVER_OAUTH_LINK, AWAIT_OAUTH_CALLBACK,
 * BIND_OAUTH_CREDENTIAL, REVOKE_OAUTH_CREDENTIAL) and the cloud services that
 * own persistence (`OAuthIntentsClient`) and callback wakeups
 * (`OAuthCallbackBusClient`).
 *
 * The actions never import the cloud module directly — they resolve the
 * client implementations via `runtime.getService(name)`.
 */

import type { DeliveryTarget } from "../../sensitive-requests/dispatch-registry.ts";

export type OAuthProvider =
	| "google"
	| "discord"
	| "linkedin"
	| "linear"
	| "shopify"
	| "calendly";

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = [
	"google",
	"discord",
	"linkedin",
	"linear",
	"shopify",
	"calendly",
] as const;

export type OAuthIntentStatus =
	| "pending"
	| "bound"
	| "denied"
	| "expired"
	| "canceled";

export interface OAuthIntentEnvelope {
	oauthIntentId: string;
	provider: OAuthProvider;
	scopes: string[];
	hostedUrl?: string;
	/** epoch ms */
	expiresAt: number;
	status: OAuthIntentStatus;
	expectedIdentityId?: string;
}

export interface OAuthCallbackResult {
	oauthIntentId: string;
	provider: OAuthProvider;
	status: "bound" | "denied" | "expired";
	connectorIdentityId?: string;
	scopesGranted?: string[];
	error?: string;
	/** epoch ms */
	receivedAt?: number;
}

export interface OAuthBindResult {
	oauthIntentId: string;
	provider: OAuthProvider;
	connectorIdentityId: string;
	scopesGranted?: string[];
}

export interface OAuthRevokeResult {
	oauthIntentId: string;
	provider: OAuthProvider;
	revoked: boolean;
	error?: string;
}

export interface CreateOAuthIntentInput {
	provider: OAuthProvider;
	scopes: string[];
	expectedIdentityId?: string;
	stateTokenHash: string;
	pkceVerifierHash?: string;
	hostedUrl?: string;
	callbackUrl?: string;
	expiresInMs?: number;
	metadata?: Record<string, unknown>;
}

/**
 * Cloud-backed CRUD client for OAuth intents. Resolved via
 * `runtime.getService(OAUTH_INTENTS_CLIENT_SERVICE)`.
 */
export interface OAuthIntentsClient {
	create(input: CreateOAuthIntentInput): Promise<OAuthIntentEnvelope>;
	get(oauthIntentId: string): Promise<OAuthIntentEnvelope | null>;
	cancel(oauthIntentId: string, reason?: string): Promise<OAuthIntentEnvelope>;
	bind(input: {
		oauthIntentId: string;
		connectorIdentityId: string;
		scopesGranted?: string[];
	}): Promise<OAuthBindResult>;
	revoke(input: {
		oauthIntentId: string;
		reason?: string;
	}): Promise<OAuthRevokeResult>;
}

/**
 * Cloud-backed callback bus client. Resolved via
 * `runtime.getService(OAUTH_CALLBACK_BUS_CLIENT_SERVICE)`.
 */
export interface OAuthCallbackBusClient {
	waitFor(
		oauthIntentId: string,
		timeoutMs: number,
	): Promise<OAuthCallbackResult>;
}

// Service name constants — used by every action's `runtime.getService(...)`
// call so the OAuth cloud adapters can register themselves under stable keys.
export const OAUTH_INTENTS_CLIENT_SERVICE = "OAuthIntentsClient";
export const OAUTH_CALLBACK_BUS_CLIENT_SERVICE = "OAuthCallbackBusClient";

/**
 * Eligible delivery targets for an OAuth authorization link. OAuth flows
 * always require the user to complete the redirect, so an authenticated /
 * private channel is preferred but a public link is allowed (the provider
 * itself enforces the consent screen).
 */
export function eligibleOAuthDeliveryTargets(): DeliveryTarget[] {
	return [
		"dm",
		"owner_app_inline",
		"cloud_authenticated_link",
		"tunnel_authenticated_link",
		"public_link",
	];
}
