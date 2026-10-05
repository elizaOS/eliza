/** Pinned Stripe request version. Webhook payloads signed with another version are logged by the queue consumer; lifecycle owners read provider state through clients pinned here. */
export const STRIPE_API_VERSION = "2024-11-20.acacia" as const;
