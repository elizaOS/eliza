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
import { getCloudAwareEnv } from "../runtime/cloud-bindings";

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

/**
 * Whether an LLM call may be captured as a training trajectory for this user.
 * An explicit `trajectory_training` revocation always wins. With no recorded
 * choice, capture continues unless `TRAJECTORY_CAPTURE_REQUIRES_CONSENT=true`,
 * which requires an explicit grant.
 */
export async function isTrajectoryCaptureAllowed(
  userId: string,
  organizationId: string,
  env: NodeJS.ProcessEnv = getCloudAwareEnv(),
): Promise<boolean> {
  const latest = await userConsentsRepository.findLatest(
    userId,
    organizationId,
    "trajectory_training",
  );
  if (latest) return latest.granted;
  return env.TRAJECTORY_CAPTURE_REQUIRES_CONSENT !== "true";
}
