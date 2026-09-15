/** Owns connector grants persistence for LifeOps. Keeps domain mutations and existing transaction or claim boundaries together. */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsChannelPolicy,
  LifeOpsConnectorGrant,
  LifeOpsConnectorSide,
} from "../../contracts/index.js";
import {
  createConnectorAccountPrivacyPolicy,
  deriveConnectorAccountIdFromGrant,
  type LifeOpsConnectorAccountPrivacyPolicy,
} from "../privacy-egress.js";
import {
  executeRawSql,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
  toText,
} from "../sql.js";
import {
  deriveConnectorIdentityEmail,
  type LifeOpsWebsiteAccessGrant,
  parseChannelPolicy,
  parseConnectorAccountPrivacyPolicy,
  parseConnectorGrant,
  parseWebsiteAccessGrant,
} from "./connector-grant-records.js";
export class ConnectorGrantRepository {
  constructor(private readonly runtime: IAgentRuntime) {}
  async upsertChannelPolicy(policy: LifeOpsChannelPolicy): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_channel_policies (
        id, agent_id, channel_type, channel_ref, privacy_class,
        allow_reminders, allow_escalation, allow_posts,
        require_confirmation_for_actions, metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(policy.id)},
        ${sqlQuote(policy.agentId)},
        ${sqlQuote(policy.channelType)},
        ${sqlQuote(policy.channelRef)},
        ${sqlQuote(policy.privacyClass)},
        ${sqlBoolean(policy.allowReminders)},
        ${sqlBoolean(policy.allowEscalation)},
        ${sqlBoolean(policy.allowPosts)},
        ${sqlBoolean(policy.requireConfirmationForActions)},
        ${sqlJson(policy.metadata)},
        ${sqlQuote(policy.createdAt)},
        ${sqlQuote(policy.updatedAt)}
      )
      ON CONFLICT(agent_id, channel_type, channel_ref) DO UPDATE SET
        privacy_class = excluded.privacy_class,
        allow_reminders = excluded.allow_reminders,
        allow_escalation = excluded.allow_escalation,
        allow_posts = excluded.allow_posts,
        require_confirmation_for_actions = excluded.require_confirmation_for_actions,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async listChannelPolicies(agentId: string): Promise<LifeOpsChannelPolicy[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_channel_policies
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY created_at ASC`,
    );
    return rows.map(parseChannelPolicy);
  }

  async getChannelPolicy(
    agentId: string,
    channelType: LifeOpsChannelPolicy["channelType"],
    channelRef: string,
  ): Promise<LifeOpsChannelPolicy | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_channel_policies
        WHERE agent_id = ${sqlQuote(agentId)}
          AND channel_type = ${sqlQuote(channelType)}
          AND channel_ref = ${sqlQuote(channelRef)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseChannelPolicy(row) : null;
  }

  async upsertWebsiteAccessGrant(
    grant: LifeOpsWebsiteAccessGrant,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_website_access_grants (
        id, agent_id, group_key, definition_id, occurrence_id, websites_json,
        unlock_mode, unlock_duration_minutes, callback_key, unlocked_at,
        expires_at, revoked_at, metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(grant.id)},
        ${sqlQuote(grant.agentId)},
        ${sqlQuote(grant.groupKey)},
        ${sqlQuote(grant.definitionId)},
        ${sqlText(grant.occurrenceId)},
        ${sqlJson(grant.websites)},
        ${sqlQuote(grant.unlockMode)},
        ${sqlInteger(grant.unlockDurationMinutes)},
        ${sqlText(grant.callbackKey)},
        ${sqlQuote(grant.unlockedAt)},
        ${sqlText(grant.expiresAt)},
        ${sqlText(grant.revokedAt)},
        ${sqlJson(grant.metadata)},
        ${sqlQuote(grant.createdAt)},
        ${sqlQuote(grant.updatedAt)}
      )`,
    );
  }

  async listWebsiteAccessGrants(
    agentId: string,
  ): Promise<LifeOpsWebsiteAccessGrant[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_website_access_grants
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY updated_at DESC, created_at DESC`,
    );
    return rows.map(parseWebsiteAccessGrant);
  }

  async revokeWebsiteAccessGrants(
    agentId: string,
    args: {
      groupKey?: string;
      callbackKey?: string;
      revokedAt: string;
    },
  ): Promise<void> {
    const clauses = [`agent_id = ${sqlQuote(agentId)}`, "revoked_at IS NULL"];
    if (args.groupKey) {
      clauses.push(`group_key = ${sqlQuote(args.groupKey)}`);
    }
    if (args.callbackKey) {
      clauses.push(`callback_key = ${sqlQuote(args.callbackKey)}`);
    }
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_website_access_grants
          SET revoked_at = ${sqlQuote(args.revokedAt)},
              updated_at = ${sqlQuote(args.revokedAt)}
        WHERE ${clauses.join("\n          AND ")}`,
    );
  }

  async ensureConnectorAccountPrivacy(input: {
    agentId: string;
    provider: string;
    connectorAccountId: string;
  }): Promise<LifeOpsConnectorAccountPrivacyPolicy> {
    const existing = await this.getConnectorAccountPrivacy(
      input.agentId,
      input.provider,
      input.connectorAccountId,
    );
    if (existing) return existing;

    const policy = createConnectorAccountPrivacyPolicy(input);
    await this.upsertConnectorAccountPrivacy(policy);
    return policy;
  }

  async upsertConnectorAccountPrivacy(
    input: LifeOpsConnectorAccountPrivacyPolicy,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_account_privacy (
        id, agent_id, provider, connector_account_id, visibility_scope,
        allowed_data_classes_json, metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(input.id)},
        ${sqlQuote(input.agentId)},
        ${sqlQuote(input.provider)},
        ${sqlQuote(input.connectorAccountId)},
        ${sqlQuote(input.visibilityScope)},
        ${sqlJson(input.allowedDataClasses)},
        ${sqlJson(input.metadata)},
        ${sqlQuote(input.createdAt)},
        ${sqlQuote(input.updatedAt)}
      )
      ON CONFLICT(agent_id, provider, connector_account_id) DO UPDATE SET
        visibility_scope = excluded.visibility_scope,
        allowed_data_classes_json = excluded.allowed_data_classes_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async listConnectorAccountPrivacy(
    agentId: string,
  ): Promise<LifeOpsConnectorAccountPrivacyPolicy[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_account_privacy
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY provider ASC, connector_account_id ASC`,
    );
    return rows.map(parseConnectorAccountPrivacyPolicy);
  }

  async getConnectorAccountPrivacy(
    agentId: string,
    provider: string,
    connectorAccountId: string,
  ): Promise<LifeOpsConnectorAccountPrivacyPolicy | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_account_privacy
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND connector_account_id = ${sqlQuote(connectorAccountId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseConnectorAccountPrivacyPolicy(row) : null;
  }

  async upsertConnectorGrant(grant: LifeOpsConnectorGrant): Promise<void> {
    const identityEmail = deriveConnectorIdentityEmail(grant.identity);
    const connectorAccountId =
      grant.connectorAccountId ?? deriveConnectorAccountIdFromGrant(grant);
    const logicalIdentityClause =
      identityEmail === null
        ? "identity_email IS NULL"
        : `identity_email = ${sqlQuote(identityEmail)}`;
    const existingRows = await executeRawSql(
      this.runtime,
      `SELECT id, created_at
         FROM app_lifeops.life_connector_grants
        WHERE agent_id = ${sqlQuote(grant.agentId)}
          AND provider = ${sqlQuote(grant.provider)}
          AND side = ${sqlQuote(grant.side)}
          AND mode = ${sqlQuote(grant.mode)}
          AND ${logicalIdentityClause}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`,
    );
    const existingRow = existingRows[0] ?? null;
    const targetId = existingRow ? toText(existingRow.id, grant.id) : grant.id;
    const createdAt = existingRow
      ? toText(existingRow.created_at, grant.createdAt)
      : grant.createdAt;

    if (existingRow) {
      await executeRawSql(
        this.runtime,
        `UPDATE app_lifeops.life_connector_grants
            SET connector_account_id = ${sqlText(connectorAccountId)},
                identity_json = ${sqlJson(grant.identity)},
                identity_email = ${sqlText(identityEmail)},
                granted_scopes_json = ${sqlJson(grant.grantedScopes)},
                capabilities_json = ${sqlJson(grant.capabilities)},
                token_ref = ${sqlText(grant.tokenRef)},
                execution_target = ${sqlQuote(grant.executionTarget)},
                source_of_truth = ${sqlQuote(grant.sourceOfTruth)},
                preferred_by_agent = ${sqlBoolean(grant.preferredByAgent)},
                cloud_connection_id = ${sqlText(grant.cloudConnectionId)},
                metadata_json = ${sqlJson(grant.metadata)},
                last_refresh_at = ${sqlText(grant.lastRefreshAt)},
                updated_at = ${sqlQuote(grant.updatedAt)}
          WHERE id = ${sqlQuote(targetId)}`,
      );
    } else {
      await executeRawSql(
        this.runtime,
        `INSERT INTO app_lifeops.life_connector_grants (
          id, agent_id, provider, connector_account_id, side, identity_json,
          identity_email, granted_scopes_json, capabilities_json, token_ref,
          mode, execution_target, source_of_truth, preferred_by_agent,
          cloud_connection_id, metadata_json, last_refresh_at, created_at,
          updated_at
        ) VALUES (
          ${sqlQuote(targetId)},
          ${sqlQuote(grant.agentId)},
          ${sqlQuote(grant.provider)},
          ${sqlText(connectorAccountId)},
          ${sqlQuote(grant.side)},
          ${sqlJson(grant.identity)},
          ${sqlText(identityEmail)},
          ${sqlJson(grant.grantedScopes)},
          ${sqlJson(grant.capabilities)},
          ${sqlText(grant.tokenRef)},
          ${sqlQuote(grant.mode)},
          ${sqlQuote(grant.executionTarget)},
          ${sqlQuote(grant.sourceOfTruth)},
          ${sqlBoolean(grant.preferredByAgent)},
          ${sqlText(grant.cloudConnectionId)},
          ${sqlJson(grant.metadata)},
          ${sqlText(grant.lastRefreshAt)},
          ${sqlQuote(createdAt)},
          ${sqlQuote(grant.updatedAt)}
        )
        ON CONFLICT(id) DO UPDATE SET
          agent_id = excluded.agent_id,
          provider = excluded.provider,
          connector_account_id = excluded.connector_account_id,
          side = excluded.side,
          identity_json = excluded.identity_json,
          identity_email = excluded.identity_email,
          granted_scopes_json = excluded.granted_scopes_json,
          capabilities_json = excluded.capabilities_json,
          token_ref = excluded.token_ref,
          execution_target = excluded.execution_target,
          source_of_truth = excluded.source_of_truth,
          preferred_by_agent = excluded.preferred_by_agent,
          cloud_connection_id = excluded.cloud_connection_id,
          metadata_json = excluded.metadata_json,
          last_refresh_at = excluded.last_refresh_at,
          created_at = app_lifeops.life_connector_grants.created_at,
          updated_at = excluded.updated_at`,
      );
    }

    await this.ensureConnectorAccountPrivacy({
      agentId: grant.agentId,
      provider: grant.provider,
      connectorAccountId,
    });
  }

  async listConnectorGrants(agentId: string): Promise<LifeOpsConnectorGrant[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_connector_grants
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY created_at ASC`,
    );
    return rows.map(parseConnectorGrant);
  }

  async getConnectorGrant(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    mode: LifeOpsConnectorGrant["mode"],
    side: LifeOpsConnectorSide = "owner",
  ): Promise<LifeOpsConnectorGrant | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
        FROM app_lifeops.life_connector_grants
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND side = ${sqlQuote(side)}
          AND mode = ${sqlQuote(mode)}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseConnectorGrant(row) : null;
  }

  async deleteConnectorGrant(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    mode?: LifeOpsConnectorGrant["mode"],
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<void> {
    const modeClause = mode ? `AND mode = ${sqlQuote(mode)}` : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const grantClause = grantId ? `AND id = ${sqlQuote(grantId)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_connector_grants
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${modeClause}
          ${sideClause}
          ${grantClause}`,
    );
  }
}
