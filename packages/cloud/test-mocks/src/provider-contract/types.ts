/** Defines deterministic provider-protocol fixtures and conformance observations. */

export const PROVIDER_CONTRACT_SCENARIOS = [
  "oauth-state-pkce",
  "oauth-refresh-rotation",
  "oauth-revoked-credential",
  "oauth-expired-credential",
  "success",
  "designed-empty",
  "invalid-input",
  "pagination-cursors",
  "rate-limit-retry-metadata",
  "malformed-json",
  "schema-drift",
  "timeout",
  "connection-reset",
  "provider-4xx",
  "provider-5xx",
  "duplicate-webhook",
  "out-of-order-webhook",
  "webhook-idempotency",
  "cross-tenant-denial",
  "opaque-connection-id",
  "secret-redaction",
  "read-policy",
  "write-policy-receipt",
  "irreversible-policy-receipt",
] as const;

export type ProviderContractScenario =
  (typeof PROVIDER_CONTRACT_SCENARIOS)[number];

export type ProviderContractCapability =
  | "oauth"
  | "http-read"
  | "http-write"
  | "irreversible-write"
  | "pagination"
  | "tenant-isolation"
  | "webhooks";

export interface ProviderContractObservation {
  scenario: ProviderContractScenario;
  status: "passed" | "not-applicable";
  detail: string;
  receiptId?: string;
  connectionId?: string;
  diagnostic?: unknown;
}

export interface ProviderProtocolFixture {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  requiresAccessToken?: boolean;
  requiresOrganization?: boolean;
  expectedOrganizationId?: string;
  response: {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
}

export type ProviderProtocolFault =
  | { type: "delay"; durationMs: number }
  | { type: "malformed-json"; body?: string }
  | { type: "schema-drift"; body: unknown }
  | { type: "status"; status: number; body?: unknown };

export interface RecordedProviderRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
}

export interface ProviderActionReceipt {
  id: string;
  action: string;
  effect: "read" | "write" | "irreversible";
  outcome: "succeeded" | "denied";
  createdAt: string;
}
