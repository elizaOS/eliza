/**
 * Server-recorded consent decisions (append-only ledger) and the policy gates
 * that read them. Consent is never asserted by the client at use time: callers
 * resolve it from the ledger.
 */

import type { DbTransaction } from "../../db/client";
import {
  type UserConsent,
  type UserConsentPurpose,
  userConsentsRepository,
} from "../../db/repositories/user-consents";
import { USER_CONSENT_PURPOSES } from "../../db/schemas/user-consents";

export { USER_CONSENT_PURPOSES, type UserConsentPurpose };

/** Wire shape of one consent decision (`/api/v1/me/consents`). */
export interface UserConsentDto {
  purpose: UserConsentPurpose;
  granted: boolean;
  policyVersion: string;
  source: string;
  recordedAt: string;
}

export function toUserConsentDto(row: UserConsent): UserConsentDto {
  return {
    purpose: row.purpose,
    granted: row.granted,
    policyVersion: row.policy_version,
    source: row.source,
    recordedAt: new Date(row.recorded_at).toISOString(),
  };
}

export async function listLatestUserConsents(
  userId: string,
  organizationId: string,
): Promise<UserConsentDto[]> {
  return (await userConsentsRepository.listLatest(userId, organizationId)).map(toUserConsentDto);
}

/**
 * Server policy applied to one purpose. `basis: "recorded"` means the user's
 * latest ledger entry decides; `basis: "default"` means no choice is recorded
 * and the deployment default decides.
 */
export interface EffectiveConsentDto {
  purpose: UserConsentPurpose;
  granted: boolean;
  basis: "recorded" | "default";
  defaultGranted: boolean;
}

/**
 * Deployment default per purpose when the user has recorded no choice. Vision
 * capture is always opt-in. Model-call recording is a deployment policy, not a
 * consent purpose (see `config/llm-trajectory-policy`).
 */
export function resolveConsentDefaults(): Record<UserConsentPurpose, boolean> {
  return { vision_capture: false };
}

/** The policy the server enforces for each purpose, given recorded choices. */
export function resolveEffectiveConsents(
  consents: readonly UserConsentDto[],
): EffectiveConsentDto[] {
  const defaults = resolveConsentDefaults();
  return USER_CONSENT_PURPOSES.map((purpose) => {
    const recorded = consents.find((consent) => consent.purpose === purpose);
    return recorded
      ? { purpose, granted: recorded.granted, basis: "recorded", defaultGranted: defaults[purpose] }
      : {
          purpose,
          granted: defaults[purpose],
          basis: "default",
          defaultGranted: defaults[purpose],
        };
  });
}

export async function recordUserConsent(
  input: {
    userId: string;
    organizationId: string;
    purpose: UserConsentPurpose;
    granted: boolean;
    policyVersion: string;
    source: string;
  },
  tx?: DbTransaction,
): Promise<UserConsentDto> {
  const row = await userConsentsRepository.append(
    {
      user_id: input.userId,
      organization_id: input.organizationId,
      purpose: input.purpose,
      granted: input.granted,
      policy_version: input.policyVersion,
      source: input.source,
    },
    tx,
  );
  return toUserConsentDto(row);
}
