/**
 * Server-authoritative privacy consent client for `GET/POST /api/v1/me/consents`.
 *
 * Eliza Cloud stores one append-only record per choice (purpose, granted,
 * policy version, source, time) and emits the audit event for each change, so
 * the browser never owns consent state. Responses are validated at this
 * boundary; a malformed payload is an error, never "not consented".
 */

import { ElizaError } from "@elizaos/core/errors";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api-client";
import {
  authenticatedQueryKey,
  useAuthenticatedQueryGate,
} from "../../lib/auth-query";

export type ConsentPurpose = "vision_capture" | "trajectory_training";

/** Version of the privacy copy the user is agreeing to in this panel. */
export const PRIVACY_CONSENT_POLICY_VERSION = "2026-09-privacy-panel-v1";

export interface ConsentRecord {
  purpose: ConsentPurpose;
  granted: boolean;
  policyVersion: string;
  source: string;
  recordedAt: string;
}

/** Latest record per purpose; an absent purpose means no choice is recorded. */
export type ConsentState = Partial<Record<ConsentPurpose, ConsentRecord>>;

const CONSENT_PURPOSES: ReadonlySet<string> = new Set<ConsentPurpose>([
  "vision_capture",
  "trajectory_training",
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

export function parseConsentList(payload: unknown): ConsentState {
  const consents =
    typeof payload === "object" && payload !== null
      ? (payload as { consents?: unknown }).consents
      : undefined;
  if (!Array.isArray(consents)) {
    throw new ConsentResponseError("Consent list response is malformed");
  }
  const state: ConsentState = {};
  for (const item of consents) {
    const record = parseConsentRecord(item);
    const existing = state[record.purpose];
    if (
      !existing ||
      Date.parse(record.recordedAt) > Date.parse(existing.recordedAt)
    ) {
      state[record.purpose] = record;
    }
  }
  return state;
}

export function parseRecordedConsent(payload: unknown): ConsentRecord {
  const consent =
    typeof payload === "object" && payload !== null
      ? (payload as { consent?: unknown }).consent
      : undefined;
  return parseConsentRecord(consent);
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

/** Record a consent choice; the cache updates only from the server receipt. */
export function useRecordConsent() {
  const gate = useAuthenticatedQueryGate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { purpose: ConsentPurpose; granted: boolean }) =>
      parseRecordedConsent(
        await api("/api/v1/me/consents", {
          method: "POST",
          json: {
            purpose: input.purpose,
            granted: input.granted,
            policyVersion: PRIVACY_CONSENT_POLICY_VERSION,
          },
        }),
      ),
    onSuccess: (record) => {
      queryClient.setQueryData<ConsentState>(
        authenticatedQueryKey(CONSENTS_KEY, gate),
        (previous) => ({ ...(previous ?? {}), [record.purpose]: record }),
      );
    },
  });
}
