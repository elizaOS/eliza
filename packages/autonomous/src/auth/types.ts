/**
 * Subscription auth types for milady.
 */

export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
}

export type SubscriptionProvider = "anthropic-subscription" | "openai-codex";

/** Maps subscription provider IDs to their model provider short names. */
export const SUBSCRIPTION_PROVIDER_MAP: Record<SubscriptionProvider, string> = {
  "anthropic-subscription": "anthropic",
  "openai-codex": "openai",
};

export interface StoredCredentials {
  provider: SubscriptionProvider;
  credentials: OAuthCredentials;
  createdAt: number;
  updatedAt: number;
}
