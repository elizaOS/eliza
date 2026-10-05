/**
 * Server-authoritative privacy consent client for `GET /api/v1/me/consents`.
 *
 * Eliza Cloud stores one append-only record per choice (purpose, granted,
 * policy version, source, time) and emits the audit event for each change, so
 * the browser never owns consent state. Responses are validated at this
 * boundary; a malformed payload is an error, never "not consented".
 *
 * The response also carries the deployment's model-call recording policy
 * (`capture.modelCallRecording`). That is read-only deployment configuration,
 * not a consent purpose, and the panel only discloses it.
 */

import { ElizaError } from "@elizaos/core/protocol";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api-client";
import {
  authenticatedQueryKey,
  useAuthenticatedQueryGate,
} from "../../lib/auth-query";

export type ConsentPurpose = "vision_capture";

export interface ConsentRecord {
  purpose: ConsentPurpose;
  granted: boolean;
  policyVersion: string;
  source: string;
  recordedAt: string;
}

/**
 * The policy the server enforces for one purpose. `basis: "default"` means no
 * choice is recorded and the deployment default (`defaultGranted`) applies.
 */
export interface EffectiveConsent {
  purpose: ConsentPurpose;
  granted: boolean;
  basis: "recorded" | "default";
  defaultGranted: boolean;
}

/** Deployment policy for recording model calls (read-only). */
export interface ModelCallRecordingPolicy {
  enabled: boolean;
  source: "explicit" | "deployment-default";
  retentionDays: number;
}

/**
 * Latest record per purpose (an absent purpose means no choice is recorded),
 * the server-enforced policy for every purpose, and the deployment's
 * model-call recording policy.
 */
export interface ConsentState {
  recorded: Partial<Record<ConsentPurpose, ConsentRecord>>;
  effective: Record<ConsentPurpose, EffectiveConsent>;
  capture: { modelCallRecording: ModelCallRecordingPolicy };
}

const CONSENT_PURPOSES: ReadonlySet<string> = new Set<ConsentPurpose>([
  "vision_capture",
]);

/** Typed boundary failure for a consent payload the client cannot trust. */
export class ConsentResponseError extends ElizaError {
  override readonly name = "ConsentResponseError";

  constructor(message: string) {
    super(message, { code: "CONSENT_RESPONSE_INVALID", severity: "fatal" });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function parseConsentRecord(value: unknown): ConsentRecord {
  if (typeof value !== "object" || value === null) {
    throw new ConsentResponseError("Consent record was not an object");
  }
  const record = value as Record<string, unknown>;
  const { purpose, granted, policyVersion, source, recordedAt } = record;
  if (typeof purpose !== "string" || !CONSENT_PURPOSES.has(purpose)) {
    throw new ConsentResponseError("Consent record has an unknown purpose");
  }
  if (
    typeof granted !== "boolean" ||
    typeof policyVersion !== "string" ||
    typeof source !== "string" ||
    typeof recordedAt !== "string" ||
    Number.isNaN(Date.parse(recordedAt))
  ) {
    throw new ConsentResponseError("Consent record is malformed");
  }
  return {
    purpose: purpose as ConsentPurpose,
    granted,
    policyVersion,
    source,
    recordedAt,
  };
}

function parseEffectiveConsent(value: unknown): EffectiveConsent {
  if (typeof value !== "object" || value === null) {
    throw new ConsentResponseError("Effective consent was not an object");
  }
  const { purpose, granted, basis, defaultGranted } = value as Record<
    string,
    unknown
  >;
  if (typeof purpose !== "string" || !CONSENT_PURPOSES.has(purpose)) {
    throw new ConsentResponseError("Effective consent has an unknown purpose");
  }
  if (
    typeof granted !== "boolean" ||
    typeof defaultGranted !== "boolean" ||
    (basis !== "recorded" && basis !== "default")
  ) {
    throw new ConsentResponseError("Effective consent is malformed");
  }
  return {
    purpose: purpose as ConsentPurpose,
    granted,
    basis,
    defaultGranted,
  };
}

function parseModelCallRecording(value: unknown): ModelCallRecordingPolicy {
  const recording =
    typeof value === "object" && value !== null
      ? (value as { modelCallRecording?: unknown }).modelCallRecording
      : undefined;
  if (typeof recording !== "object" || recording === null) {
    throw new ConsentResponseError(
      "Consent list response is missing the model-call recording policy",
    );
  }
  const { enabled, source, retentionDays } = recording as Record<
    string,
    unknown
  >;
  if (
    typeof enabled !== "boolean" ||
    (source !== "explicit" && source !== "deployment-default") ||
    typeof retentionDays !== "number" ||
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 1
  ) {
    throw new ConsentResponseError("Model-call recording policy is malformed");
  }
  return { enabled, source, retentionDays };
}

export function parseConsentList(payload: unknown): ConsentState {
  const body =
    typeof payload === "object" && payload !== null
      ? (payload as {
          consents?: unknown;
          effective?: unknown;
          capture?: unknown;
        })
      : undefined;
  if (!Array.isArray(body?.consents) || !Array.isArray(body.effective)) {
    throw new ConsentResponseError("Consent list response is malformed");
  }
  const recorded: ConsentState["recorded"] = {};
  for (const item of body.consents) {
    const record = parseConsentRecord(item);
    const existing = recorded[record.purpose];
    if (
      !existing ||
      Date.parse(record.recordedAt) > Date.parse(existing.recordedAt)
    ) {
      recorded[record.purpose] = record;
    }
  }
  const effective: Partial<Record<ConsentPurpose, EffectiveConsent>> = {};
  for (const item of body.effective) {
    const entry = parseEffectiveConsent(item);
    effective[entry.purpose] = entry;
  }
  const vision = effective.vision_capture;
  if (!vision) {
    throw new ConsentResponseError(
      "Consent list response is missing an effective policy",
    );
  }
  return {
    recorded,
    effective: { vision_capture: vision },
    capture: { modelCallRecording: parseModelCallRecording(body.capture) },
  };
}

const CONSENTS_KEY = ["cloud-account", "consents"] as const;

/** Current consent records for the signed-in user. */
export function useConsents() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(CONSENTS_KEY, gate),
    queryFn: async () => parseConsentList(await api("/api/v1/me/consents")),
    enabled: gate.enabled,
  });
}
