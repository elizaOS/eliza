/** Defines and parses connector grant records for the LifeOps persistence boundary, preserving public factory and row contracts. */

import crypto from "node:crypto";
import type {
  LifeOpsChannelPolicy,
  LifeOpsConnectorGrant,
} from "../../contracts/index.js";
import {
  deriveConnectorAccountIdFromGrant,
  type LifeOpsConnectorAccountPrivacyPolicy,
  normalizeLifeOpsAccountPrivacyScope,
  normalizeLifeOpsEgressDataClasses,
} from "../privacy-egress.js";
import {
  parseJsonArray,
  parseJsonRecord,
  toBoolean,
  toNumber,
  toText,
} from "../sql.js";
import { isoNow } from "./record-values.js";

export function normalizeConnectorIdentityEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function deriveConnectorIdentityEmail(
  identity: Record<string, unknown>,
): string | null {
  return (
    normalizeConnectorIdentityEmail(identity.email) ??
    normalizeConnectorIdentityEmail(identity.emailAddress) ??
    normalizeConnectorIdentityEmail(identity.primaryEmail)
  );
}

export interface LifeOpsWebsiteAccessGrant {
  id: string;
  agentId: string;
  groupKey: string;
  definitionId: string;
  occurrenceId: string | null;
  websites: string[];
  unlockMode: "fixed_duration" | "until_manual_lock" | "until_callback";
  unlockDurationMinutes: number | null;
  callbackKey: string | null;
  unlockedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function parseChannelPolicy(
  row: Record<string, unknown>,
): LifeOpsChannelPolicy {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    channelType: toText(
      row.channel_type,
    ) as LifeOpsChannelPolicy["channelType"],
    channelRef: toText(row.channel_ref),
    privacyClass: toText(
      row.privacy_class,
    ) as LifeOpsChannelPolicy["privacyClass"],
    allowReminders: toBoolean(row.allow_reminders),
    allowEscalation: toBoolean(row.allow_escalation),
    allowPosts: toBoolean(row.allow_posts),
    requireConfirmationForActions: toBoolean(
      row.require_confirmation_for_actions,
    ),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseWebsiteAccessGrant(
  row: Record<string, unknown>,
): LifeOpsWebsiteAccessGrant {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    groupKey: toText(row.group_key),
    definitionId: toText(row.definition_id),
    occurrenceId: row.occurrence_id ? toText(row.occurrence_id) : null,
    websites: parseJsonArray(row.websites_json),
    unlockMode: toText(
      row.unlock_mode,
    ) as LifeOpsWebsiteAccessGrant["unlockMode"],
    unlockDurationMinutes: row.unlock_duration_minutes
      ? toNumber(row.unlock_duration_minutes, 0)
      : null,
    callbackKey: row.callback_key ? toText(row.callback_key) : null,
    unlockedAt: toText(row.unlocked_at),
    expiresAt: row.expires_at ? toText(row.expires_at) : null,
    revokedAt: row.revoked_at ? toText(row.revoked_at) : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseConnectorGrant(
  row: Record<string, unknown>,
): LifeOpsConnectorGrant {
  const identity = parseJsonRecord(row.identity_json);
  const grant: LifeOpsConnectorGrant = {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: toText(row.provider) as LifeOpsConnectorGrant["provider"],
    connectorAccountId: row.connector_account_id
      ? toText(row.connector_account_id)
      : null,
    side: toText(row.side, "owner") as LifeOpsConnectorGrant["side"],
    identity,
    identityEmail: row.identity_email ? toText(row.identity_email) : null,
    grantedScopes: parseJsonArray(row.granted_scopes_json),
    capabilities: parseJsonArray(row.capabilities_json),
    tokenRef: row.token_ref ? toText(row.token_ref) : null,
    mode: toText(row.mode) as LifeOpsConnectorGrant["mode"],
    executionTarget: toText(
      row.execution_target ?? "local",
    ) as LifeOpsConnectorGrant["executionTarget"],
    sourceOfTruth: toText(
      row.source_of_truth ?? "local_storage",
    ) as LifeOpsConnectorGrant["sourceOfTruth"],
    preferredByAgent: toBoolean(row.preferred_by_agent ?? false),
    cloudConnectionId: row.cloud_connection_id
      ? toText(row.cloud_connection_id)
      : null,
    metadata: parseJsonRecord(row.metadata_json),
    lastRefreshAt: row.last_refresh_at ? toText(row.last_refresh_at) : null,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
  return {
    ...grant,
    connectorAccountId:
      grant.connectorAccountId ?? deriveConnectorAccountIdFromGrant(grant),
  };
}

export function parseConnectorAccountPrivacyPolicy(
  row: Record<string, unknown>,
): LifeOpsConnectorAccountPrivacyPolicy {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: toText(row.provider),
    connectorAccountId: toText(row.connector_account_id),
    visibilityScope: normalizeLifeOpsAccountPrivacyScope(row.visibility_scope),
    allowedDataClasses: normalizeLifeOpsEgressDataClasses(
      parseJsonArray(row.allowed_data_classes_json),
    ),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function createLifeOpsChannelPolicy(
  params: Omit<LifeOpsChannelPolicy, "id" | "createdAt" | "updatedAt">,
): LifeOpsChannelPolicy {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsWebsiteAccessGrant(
  params: Omit<LifeOpsWebsiteAccessGrant, "id" | "createdAt" | "updatedAt">,
): LifeOpsWebsiteAccessGrant {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

// `createLifeOpsSleepEpisode` lives in `@elizaos/plugin-health`; re-exported
// at the top of this file.

export function createLifeOpsConnectorGrant(
  params: Omit<
    LifeOpsConnectorGrant,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "side"
    | "executionTarget"
    | "sourceOfTruth"
    | "preferredByAgent"
    | "cloudConnectionId"
  > &
    Partial<
      Pick<
        LifeOpsConnectorGrant,
        | "side"
        | "executionTarget"
        | "sourceOfTruth"
        | "preferredByAgent"
        | "cloudConnectionId"
      >
    >,
): LifeOpsConnectorGrant {
  const timestamp = isoNow();
  const id = crypto.randomUUID();
  const grant: LifeOpsConnectorGrant = {
    ...params,
    connectorAccountId: params.connectorAccountId ?? null,
    side: params.side ?? "owner",
    executionTarget: params.executionTarget ?? "local",
    sourceOfTruth: params.sourceOfTruth ?? "local_storage",
    preferredByAgent: params.preferredByAgent ?? false,
    cloudConnectionId: params.cloudConnectionId ?? null,
    id,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    ...grant,
    connectorAccountId:
      grant.connectorAccountId ?? deriveConnectorAccountIdFromGrant(grant),
  };
}
