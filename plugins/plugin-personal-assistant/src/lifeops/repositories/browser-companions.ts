/** Adapts LifeOps browser companions persistence to canonical domain records. Preserves existing agent scoping, transaction handles, and conditional mutation contracts. */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  BrowserBridgeCompanionStatus,
  BrowserBridgeSettings,
} from "@elizaos/plugin-browser";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
  toText,
  withTransaction,
} from "../sql.js";
import {
  BROWSER_COMPANION_WILDCARD_PROFILE_ID,
  type BrowserCompanionCredential,
  type BrowserCompanionPendingPromotionResult,
  type BrowserCompanionRevocation,
  browserCompanionRevocationExists,
  lockBrowserCompanionCredential,
  parseBrowserCompanion,
  parseBrowserCompanionCredential,
  parseBrowserSettings,
} from "./browser-records.js";
import { resolveBrowserBridgeTable } from "./browser-tables.js";
import { isoNow } from "./record-values.js";
export class BrowserCompanionRepository {
  constructor(private readonly runtime: IAgentRuntime) {}
  async getBrowserSettings(
    agentId: string,
  ): Promise<BrowserBridgeSettings | null> {
    const settingsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "settings",
    );
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${settingsTable}
        WHERE agent_id = ${sqlQuote(agentId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseBrowserSettings(row) : null;
  }

  async upsertBrowserSettings(
    agentId: string,
    settings: BrowserBridgeSettings,
  ): Promise<void> {
    const createdAt = settings.updatedAt ?? isoNow();
    const settingsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "settings",
    );
    await executeRawSql(
      this.runtime,
      `INSERT INTO ${settingsTable} (
        agent_id, enabled, tracking_mode, allow_browser_control,
        require_confirmation_for_account_affecting, incognito_enabled,
        site_access_mode, granted_origins_json, blocked_origins_json,
        max_remembered_tabs, pause_until, metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(agentId)},
        ${sqlBoolean(settings.enabled)},
        ${sqlQuote(settings.trackingMode)},
        ${sqlBoolean(settings.allowBrowserControl)},
        ${sqlBoolean(settings.requireConfirmationForAccountAffecting)},
        ${sqlBoolean(settings.incognitoEnabled)},
        ${sqlQuote(settings.siteAccessMode)},
        ${sqlJson(settings.grantedOrigins)},
        ${sqlJson(settings.blockedOrigins)},
        ${sqlInteger(settings.maxRememberedTabs)},
        ${sqlText(settings.pauseUntil)},
        ${sqlJson(settings.metadata)},
        ${sqlQuote(createdAt)},
        ${sqlQuote(settings.updatedAt ?? createdAt)}
      )
      ON CONFLICT(agent_id) DO UPDATE SET
        enabled = excluded.enabled,
        tracking_mode = excluded.tracking_mode,
        allow_browser_control = excluded.allow_browser_control,
        require_confirmation_for_account_affecting = excluded.require_confirmation_for_account_affecting,
        incognito_enabled = excluded.incognito_enabled,
        site_access_mode = excluded.site_access_mode,
        granted_origins_json = excluded.granted_origins_json,
        blocked_origins_json = excluded.blocked_origins_json,
        max_remembered_tabs = excluded.max_remembered_tabs,
        pause_until = excluded.pause_until,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async getBrowserCompanionByProfile(
    agentId: string,
    browser: BrowserBridgeCompanionStatus["browser"],
    profileId: string,
  ): Promise<BrowserBridgeCompanionStatus | null> {
    const companionsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "companions",
    );
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${companionsTable}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND browser = ${sqlQuote(browser)}
          AND profile_id = ${sqlQuote(profileId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseBrowserCompanion(row) : null;
  }

  async getBrowserCompanionCredential(
    agentId: string,
    companionId: string,
  ): Promise<BrowserCompanionCredential | null> {
    const companionsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "companions",
    );
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${companionsTable}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(companionId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseBrowserCompanionCredential(row) : null;
  }

  async upsertBrowserCompanion(
    companion: BrowserBridgeCompanionStatus,
  ): Promise<void> {
    const companionsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "companions",
    );
    await executeRawSql(
      this.runtime,
      `INSERT INTO ${companionsTable} (
        id, agent_id, browser, profile_id, profile_label, label,
        extension_version, connection_state, permissions_json, last_seen_at,
        paired_at, metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(companion.id)},
        ${sqlQuote(companion.agentId)},
        ${sqlQuote(companion.browser)},
        ${sqlQuote(companion.profileId)},
        ${sqlQuote(companion.profileLabel)},
        ${sqlQuote(companion.label)},
        ${sqlText(companion.extensionVersion)},
        ${sqlQuote(companion.connectionState)},
        ${sqlJson(companion.permissions)},
        ${sqlText(companion.lastSeenAt)},
        ${sqlText(companion.pairedAt)},
        ${sqlJson(companion.metadata)},
        ${sqlQuote(companion.createdAt)},
        ${sqlQuote(companion.updatedAt)}
      )
      ON CONFLICT(agent_id, browser, profile_id) DO UPDATE SET
        profile_label = excluded.profile_label,
        label = excluded.label,
        extension_version = excluded.extension_version,
        connection_state = excluded.connection_state,
        permissions_json = excluded.permissions_json,
        last_seen_at = excluded.last_seen_at,
        paired_at = COALESCE(${companionsTable}.paired_at, excluded.paired_at),
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async updateBrowserCompanionPairingToken(args: {
    agentId: string;
    ownerEntityId: string;
    companionId: string;
    browser: BrowserBridgeCompanionStatus["browser"];
    profileId: string;
    pairingTokenHash: string;
    pairingTokenExpiresAt: string | null;
    pairedAt: string;
    updatedAt: string;
  }): Promise<boolean> {
    const companionsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "companions",
    );
    return await withTransaction(this.runtime, async (tx) => {
      const credential = await lockBrowserCompanionCredential(
        tx,
        companionsTable,
        args.agentId,
        args.companionId,
      );
      if (!credential) return false;
      if (await browserCompanionRevocationExists(tx, args)) return false;
      await executeRawSqlTx(
        tx,
        `UPDATE ${companionsTable}
            SET pairing_token_hash = ${sqlQuote(args.pairingTokenHash)},
                pairing_token_expires_at = ${sqlText(args.pairingTokenExpiresAt)},
                pairing_token_revoked_at = NULL,
                pending_pairing_token_hashes_json = '[]',
                paired_at = ${sqlQuote(args.pairedAt)},
                updated_at = ${sqlQuote(args.updatedAt)}
          WHERE agent_id = ${sqlQuote(args.agentId)}
            AND id = ${sqlQuote(args.companionId)}`,
      );
      return true;
    });
  }

  async updateBrowserCompanionPendingPairingTokenHashes(args: {
    agentId: string;
    ownerEntityId: string;
    companionId: string;
    browser: BrowserBridgeCompanionStatus["browser"];
    profileId: string;
    pairingTokenHash: string;
    pairingTokenExpiresAt: string | null;
    updatedAt: string;
  }): Promise<boolean> {
    const companionsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "companions",
    );
    return await withTransaction(this.runtime, async (tx) => {
      const credential = await lockBrowserCompanionCredential(
        tx,
        companionsTable,
        args.agentId,
        args.companionId,
      );
      if (!credential) return false;
      if (await browserCompanionRevocationExists(tx, args)) return false;
      const pendingPairingTokens = [
        {
          hash: args.pairingTokenHash,
          expiresAt: args.pairingTokenExpiresAt,
        },
        ...credential.pendingPairingTokens,
      ]
        .filter(
          (candidate, index, candidates) =>
            candidate.hash !== credential.pairingTokenHash &&
            candidates.findIndex((other) => other.hash === candidate.hash) ===
              index,
        )
        .slice(0, 4);
      await executeRawSqlTx(
        tx,
        `UPDATE ${companionsTable}
            SET pending_pairing_token_hashes_json = ${sqlJson(pendingPairingTokens)},
                updated_at = ${sqlQuote(args.updatedAt)}
          WHERE agent_id = ${sqlQuote(args.agentId)}
            AND id = ${sqlQuote(args.companionId)}`,
      );
      return true;
    });
  }

  async promoteBrowserCompanionPendingPairingToken(args: {
    agentId: string;
    ownerEntityId: string;
    companionId: string;
    pairingTokenHash: string;
    pairedAt: string;
    updatedAt: string;
  }): Promise<BrowserCompanionPendingPromotionResult> {
    const companionsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "companions",
    );
    return await withTransaction(this.runtime, async (tx) => {
      const credential = await lockBrowserCompanionCredential(
        tx,
        companionsTable,
        args.agentId,
        args.companionId,
      );
      if (!credential) return { ok: false, reason: "invalid" };
      if (
        credential.companion.pairingTokenRevokedAt ||
        (await browserCompanionRevocationExists(tx, {
          agentId: args.agentId,
          ownerEntityId: args.ownerEntityId,
          browser: credential.companion.browser,
          profileId: credential.companion.profileId,
        }))
      ) {
        return { ok: false, reason: "revoked" };
      }
      const promoted = credential.pendingPairingTokens.find(
        (candidate) => candidate.hash === args.pairingTokenHash,
      );
      if (!promoted) return { ok: false, reason: "invalid" };
      const remainingPendingPairingTokens =
        credential.pendingPairingTokens.filter(
          (candidate) => candidate.hash !== args.pairingTokenHash,
        );
      await executeRawSqlTx(
        tx,
        `UPDATE ${companionsTable}
            SET pairing_token_hash = ${sqlQuote(args.pairingTokenHash)},
                pairing_token_expires_at = ${sqlText(promoted.expiresAt)},
                pending_pairing_token_hashes_json = ${sqlJson(remainingPendingPairingTokens)},
                paired_at = ${sqlQuote(args.pairedAt)},
                updated_at = ${sqlQuote(args.updatedAt)}
          WHERE agent_id = ${sqlQuote(args.agentId)}
            AND id = ${sqlQuote(args.companionId)}`,
      );
      return {
        ok: true,
        companion: {
          ...credential.companion,
          pairingTokenExpiresAt: promoted.expiresAt,
          pairedAt: args.pairedAt,
          updatedAt: args.updatedAt,
        },
      };
    });
  }

  async revokeBrowserCompanionPairingToken(
    agentId: string,
    companionId: string,
    revokedAt: string,
  ): Promise<void> {
    const companionsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "companions",
    );
    await executeRawSql(
      this.runtime,
      `UPDATE ${companionsTable}
          SET pairing_token_revoked_at = ${sqlQuote(revokedAt)},
              pending_pairing_token_hashes_json = '[]',
              connection_state = 'disconnected',
              updated_at = ${sqlQuote(revokedAt)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(companionId)}`,
    );
  }

  async getBrowserCompanionRevocation(
    agentId: string,
    ownerEntityId: string,
    browser: BrowserBridgeCompanionStatus["browser"],
    profileId: string,
  ): Promise<BrowserCompanionRevocation | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT agent_id, owner_entity_id, browser, profile_id, companion_id, revoked_at
         FROM app_lifeops.life_browser_companion_revocations
        WHERE agent_id = ${sqlQuote(agentId)}
          AND owner_entity_id = ${sqlQuote(ownerEntityId)}
          AND browser = ${sqlQuote(browser)}
          AND profile_id IN (
            ${sqlQuote(profileId)},
            ${sqlQuote(BROWSER_COMPANION_WILDCARD_PROFILE_ID)}
          )
        ORDER BY CASE WHEN profile_id = ${sqlQuote(profileId)} THEN 0 ELSE 1 END
        LIMIT 1`,
    );
    const row = rows[0];
    return row
      ? {
          agentId: toText(row.agent_id),
          ownerEntityId: toText(row.owner_entity_id),
          browser: toText(
            row.browser,
          ) as BrowserBridgeCompanionStatus["browser"],
          profileId: toText(row.profile_id),
          companionId: toText(row.companion_id),
          revokedAt: toText(row.revoked_at),
        }
      : null;
  }

  async revokeBrowserCompanionWithTombstone(args: {
    agentId: string;
    ownerEntityId: string;
    companion: BrowserBridgeCompanionStatus;
    revokedAt: string;
  }): Promise<void> {
    const companionsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "companions",
    );
    await withTransaction(this.runtime, async (tx) => {
      await lockBrowserCompanionCredential(
        tx,
        companionsTable,
        args.agentId,
        args.companion.id,
      );
      await executeRawSqlTx(
        tx,
        `UPDATE ${companionsTable}
            SET pairing_token_revoked_at = ${sqlQuote(args.revokedAt)},
                pending_pairing_token_hashes_json = '[]',
                connection_state = 'disconnected',
                updated_at = ${sqlQuote(args.revokedAt)}
          WHERE agent_id = ${sqlQuote(args.agentId)}
            AND browser = ${sqlQuote(args.companion.browser)}`,
      );
      await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.life_workflow_browser_sessions
            SET status = 'failed',
                result_json = (result_json::jsonb || ${sqlJson({
                  code: "browser_companion_revoked",
                  error: "Browser companion was disconnected",
                })}::jsonb)::text,
                metadata_json = (metadata_json::jsonb - 'browserActionAttempt')::text,
                updated_at = ${sqlQuote(args.revokedAt)},
                finished_at = ${sqlQuote(args.revokedAt)}
          WHERE agent_id = ${sqlQuote(args.agentId)}
            AND browser = ${sqlQuote(args.companion.browser)}
            AND subject_type = 'owner'
            AND subject_id = ${sqlQuote(args.ownerEntityId)}
            AND status IN ('queued', 'running', 'awaiting_confirmation')`,
      );
      await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_browser_companion_revocations (
           agent_id, owner_entity_id, browser, profile_id, companion_id,
           revoked_at, created_at, updated_at
         ) VALUES (
           ${sqlQuote(args.agentId)},
           ${sqlQuote(args.ownerEntityId)},
           ${sqlQuote(args.companion.browser)},
           ${sqlQuote(args.companion.profileId)},
           ${sqlQuote(args.companion.id)},
           ${sqlQuote(args.revokedAt)},
           ${sqlQuote(args.revokedAt)},
           ${sqlQuote(args.revokedAt)}
         ), (
           ${sqlQuote(args.agentId)},
           ${sqlQuote(args.ownerEntityId)},
           ${sqlQuote(args.companion.browser)},
           ${sqlQuote(BROWSER_COMPANION_WILDCARD_PROFILE_ID)},
           ${sqlQuote(args.companion.id)},
           ${sqlQuote(args.revokedAt)},
           ${sqlQuote(args.revokedAt)},
           ${sqlQuote(args.revokedAt)}
         )
         ON CONFLICT (agent_id, owner_entity_id, browser, profile_id)
         DO UPDATE SET
           companion_id = excluded.companion_id,
           revoked_at = excluded.revoked_at,
           updated_at = excluded.updated_at`,
      );
    });
  }

  async resetBrowserCompanionRevocation(args: {
    agentId: string;
    ownerEntityId: string;
    companion: BrowserBridgeCompanionStatus;
    resetAt: string;
  }): Promise<boolean> {
    const companionsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "companions",
    );
    return await withTransaction(this.runtime, async (tx) => {
      const credential = await lockBrowserCompanionCredential(
        tx,
        companionsTable,
        args.agentId,
        args.companion.id,
      );
      if (!credential) return false;
      const deleted = await executeRawSqlTx(
        tx,
        `DELETE FROM app_lifeops.life_browser_companion_revocations
          WHERE agent_id = ${sqlQuote(args.agentId)}
            AND owner_entity_id = ${sqlQuote(args.ownerEntityId)}
            AND browser = ${sqlQuote(args.companion.browser)}
          RETURNING revoked_at`,
      );
      if (deleted.length === 0) return false;
      // A wildcard tombstone deliberately makes revocation browser-wide so a
      // reinstall cannot evade it with a new profile identifier. Reset must
      // therefore clear that browser's exact and wildcard rows atomically;
      // reporting a per-profile success while the wildcard survives would
      // leave the requested profile unusable.
      await executeRawSqlTx(
        tx,
        `UPDATE ${companionsTable}
            SET pairing_token_hash = NULL,
                pairing_token_expires_at = NULL,
                pairing_token_revoked_at = NULL,
                pending_pairing_token_hashes_json = '[]',
                connection_state = 'disconnected',
                updated_at = ${sqlQuote(args.resetAt)}
          WHERE agent_id = ${sqlQuote(args.agentId)}
            AND browser = ${sqlQuote(args.companion.browser)}`,
      );
      return true;
    });
  }

  async listBrowserCompanions(
    agentId: string,
  ): Promise<BrowserBridgeCompanionStatus[]> {
    const companionsTable = await resolveBrowserBridgeTable(
      this.runtime,
      "companions",
    );
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM ${companionsTable}
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY browser ASC, profile_label ASC, label ASC`,
    );
    return rows.map(parseBrowserCompanion);
  }
}
