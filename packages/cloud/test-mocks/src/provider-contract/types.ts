/** Defines deterministic provider-protocol fixtures and conformance observations. */

import type { EffectReceipt } from "@elizaos/core";

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
  "streaming-protocol",
  "media-multimodal",
  "request-cancellation",
  "concurrent-isolation",
  "idempotent-retry",
  "message-lifecycle",
] as const;

export type ProviderContractScenario =
  (typeof PROVIDER_CONTRACT_SCENARIOS)[number];

export type ProviderContractCapability =
  | "oauth"
  | "oauth-credential-lifecycle"
  | "http-read"
  | "http-write"
  | "irreversible-write"
  | "pagination"
  | "streaming"
  | "media-multimodal"
  | "cancellation"
  | "concurrency"
  | "idempotency"
  | "message-lifecycle"
  | "tenant-isolation"
  | "webhooks";

export type ProviderContractProfile = "outbound-http" | "inbound-webhook";

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
  action?: ProviderActionPolicy;
  response: {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
}

export type ProviderCapabilityRiskLevel = "R0" | "R1" | "R2" | "R3";

/** Provider-owned policy applied at the same boundary that performs an effect. */
export interface ProviderActionPolicy {
  operation: string;
  capabilityId: string;
  effect: "read" | "write" | "irreversible";
  riskLevel: ProviderCapabilityRiskLevel;
  decision: "allow" | "deny";
  confirmation:
    | { state: "not_required" | "already_granted" }
    | { state: "required"; confirmationId: string };
}

/** Provider-owned account seed used for API credentials and OAuth grants. */
export interface FakeProviderAccount {
  accountId: string;
  tenantId: string;
  capabilities: readonly string[];
  apiCredential?: string;
}

/** OAuth client registration controlled by the provider rather than the caller. */
interface FakeProviderOAuthClientBase {
  clientId: string;
  redirectUris: readonly string[];
  accountIds: readonly string[];
}

export type FakeProviderOAuthClient = FakeProviderOAuthClientBase &
  (
    | { clientType: "public" }
    | { clientType: "confidential"; clientSecret: string }
  );

export type ProviderProtocolFault =
  | { type: "delay"; durationMs: number }
  | { type: "malformed-json"; body?: string }
  | { type: "schema-drift"; body: unknown }
  | {
      type: "status";
      status: number;
      body?: unknown;
      headers?: Record<string, string>;
    };

export interface RecordedProviderRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
}

export interface ProviderActionReceipt {
  id: string;
  tenantId: string;
  accountId: string;
  connectionId: string;
  capabilityId: string;
  operation: string;
  effectKind: "read" | "write" | "irreversible";
  outcome: "succeeded" | "denied" | "failed" | "replayed";
  request: {
    id: string;
    idempotencyKey: string | null;
    replayOfReceiptId: string | null;
  };
  policy: {
    decisionId: string;
    riskLevel: ProviderCapabilityRiskLevel;
    outcome: "allowed" | "denied";
    confirmation: "not_required" | "already_granted" | "confirmed" | "missing";
    confirmationId: string | null;
    reasonCode: string | null;
  };
  policyDecisionId: string;
  providerResult: {
    status: "accepted" | "rejected" | "not_sent";
    statusCode: number;
    resultId: string | null;
    digest: string | null;
  };
  executedEffect: {
    performed: boolean;
    effectId: string | null;
  };
  /** Canonical #19878 proof record; only `applied` proves a fresh effect. */
  effect: EffectReceipt;
  createdAt: string;
}

/** Immutable evidence that the fake upstream actually crossed its effect boundary. */
export interface ProviderExecutedEffect {
  id: string;
  tenantId: string;
  accountId: string;
  connectionId: string;
  capabilityId: string;
  operation: string;
  requestId: string;
  idempotencyKey: string | null;
  providerResultId: string;
  performedAt: string;
}
