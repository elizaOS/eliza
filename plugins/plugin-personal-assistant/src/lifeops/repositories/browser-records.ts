/** Defines and parses browser records for the host persistence adapter, preserving canonical domain contracts. */

import crypto from "node:crypto";
import type {
  BrowserBridgeCompanionStatus,
  BrowserBridgePageContext,
  BrowserBridgePermissionState,
  BrowserBridgeSettings,
  BrowserBridgeTabSummary,
} from "@elizaos/plugin-browser";
import type { LifeOpsBrowserSession } from "../../contracts/index.js";
import {
  executeRawSqlTx,
  parseJsonArray,
  parseJsonRecord,
  sqlQuote,
  type TransactionalDb,
  toBoolean,
  toNumber,
  toText,
} from "../sql.js";
import { isoNow, parseOwnershipFields } from "./record-values.js";

export type BrowserCompanionCredential = {
  companion: BrowserBridgeCompanionStatus;
  pairingTokenHash: string | null;
  pendingPairingTokens: BrowserCompanionPendingPairingToken[];
  pendingPairingTokenHashes: string[];
};

export type BrowserCompanionPendingPairingToken = {
  hash: string;
  expiresAt: string | null;
};

export type BrowserCompanionRevocation = {
  agentId: string;
  ownerEntityId: string;
  browser: BrowserBridgeCompanionStatus["browser"];
  profileId: string;
  companionId: string;
  revokedAt: string;
};

export const BROWSER_COMPANION_WILDCARD_PROFILE_ID = "*";

export type BrowserCompanionPendingPromotionResult =
  | { ok: true; companion: BrowserBridgeCompanionStatus }
  | { ok: false; reason: "invalid" | "revoked" };

export function parseBrowserSession(
  row: Record<string, unknown>,
): LifeOpsBrowserSession {
  const rawStatus = toText(row.status);
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    ...parseOwnershipFields(row),
    workflowId: row.workflow_id ? toText(row.workflow_id) : null,
    browser: row.browser
      ? (toText(row.browser) as LifeOpsBrowserSession["browser"])
      : null,
    companionId: row.companion_id ? toText(row.companion_id) : null,
    profileId: row.profile_id ? toText(row.profile_id) : null,
    windowId: row.window_id ? toText(row.window_id) : null,
    tabId: row.tab_id ? toText(row.tab_id) : null,
    title: toText(row.title),
    status:
      rawStatus === "navigating"
        ? "running"
        : (rawStatus as LifeOpsBrowserSession["status"]),
    actions: parseJsonArray(
      row.actions_json,
    ) as LifeOpsBrowserSession["actions"],
    currentActionIndex: toNumber(row.current_action_index, 0),
    awaitingConfirmationForActionId: row.awaiting_confirmation_for_action_id
      ? toText(row.awaiting_confirmation_for_action_id)
      : null,
    result: parseJsonRecord(row.result_json),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    finishedAt: row.finished_at ? toText(row.finished_at) : null,
  };
}

export function parseBrowserPermissionState(
  value: unknown,
): BrowserBridgePermissionState {
  const input = parseJsonRecord(value);
  return {
    tabs: Boolean(input.tabs),
    scripting: Boolean(input.scripting),
    activeTab: Boolean(input.activeTab),
    allOrigins: Boolean(input.allOrigins),
    grantedOrigins: Array.isArray(input.grantedOrigins)
      ? input.grantedOrigins
          .filter(
            (candidate): candidate is string => typeof candidate === "string",
          )
          .map((candidate) => candidate.trim())
          .filter((candidate) => candidate.length > 0)
      : [],
    incognitoEnabled: Boolean(input.incognitoEnabled),
  };
}

export function parseBrowserSettings(
  row: Record<string, unknown>,
): BrowserBridgeSettings {
  return {
    enabled: toBoolean(row.enabled, false),
    trackingMode: toText(
      row.tracking_mode,
      "current_tab",
    ) as BrowserBridgeSettings["trackingMode"],
    allowBrowserControl: toBoolean(row.allow_browser_control, false),
    requireConfirmationForAccountAffecting: toBoolean(
      row.require_confirmation_for_account_affecting,
      true,
    ),
    incognitoEnabled: toBoolean(row.incognito_enabled, false),
    siteAccessMode: toText(
      row.site_access_mode,
      "current_site_only",
    ) as BrowserBridgeSettings["siteAccessMode"],
    grantedOrigins: parseJsonArray(row.granted_origins_json).filter(
      (candidate): candidate is string => typeof candidate === "string",
    ),
    blockedOrigins: parseJsonArray(row.blocked_origins_json).filter(
      (candidate): candidate is string => typeof candidate === "string",
    ),
    maxRememberedTabs: toNumber(row.max_remembered_tabs, 10),
    pauseUntil: row.pause_until ? toText(row.pause_until) : null,
    metadata: parseJsonRecord(row.metadata_json),
    updatedAt: row.updated_at ? toText(row.updated_at) : null,
  };
}

export function parseBrowserCompanion(
  row: Record<string, unknown>,
): BrowserBridgeCompanionStatus {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    browser: toText(row.browser) as BrowserBridgeCompanionStatus["browser"],
    profileId: toText(row.profile_id),
    profileLabel: toText(row.profile_label),
    label: toText(row.label),
    extensionVersion: row.extension_version
      ? toText(row.extension_version)
      : null,
    connectionState: toText(
      row.connection_state,
    ) as BrowserBridgeCompanionStatus["connectionState"],
    permissions: parseBrowserPermissionState(row.permissions_json),
    lastSeenAt: row.last_seen_at ? toText(row.last_seen_at) : null,
    pairedAt: row.paired_at ? toText(row.paired_at) : null,
    pairingTokenExpiresAt: row.pairing_token_expires_at
      ? toText(row.pairing_token_expires_at)
      : null,
    pairingTokenRevokedAt: row.pairing_token_revoked_at
      ? toText(row.pairing_token_revoked_at)
      : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseBrowserCompanionPendingPairingTokens(
  value: unknown,
): BrowserCompanionPendingPairingToken[] {
  return parseJsonArray(value)
    .map((candidate): BrowserCompanionPendingPairingToken | null => {
      if (typeof candidate === "string" && candidate.length > 0) {
        return { hash: candidate, expiresAt: null };
      }
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        return null;
      }
      const record = candidate as Record<string, unknown>;
      if (typeof record.hash !== "string" || record.hash.length === 0) {
        return null;
      }
      return {
        hash: record.hash,
        expiresAt:
          typeof record.expiresAt === "string" && record.expiresAt.length > 0
            ? record.expiresAt
            : null,
      };
    })
    .filter(
      (candidate): candidate is BrowserCompanionPendingPairingToken =>
        candidate !== null,
    );
}

export function parseBrowserCompanionCredential(
  row: Record<string, unknown>,
): BrowserCompanionCredential {
  const pendingPairingTokens = parseBrowserCompanionPendingPairingTokens(
    row.pending_pairing_token_hashes_json,
  );
  return {
    companion: parseBrowserCompanion(row),
    pairingTokenHash: row.pairing_token_hash
      ? toText(row.pairing_token_hash)
      : null,
    pendingPairingTokens,
    pendingPairingTokenHashes: pendingPairingTokens.map((token) => token.hash),
  };
}

export async function lockBrowserCompanionCredential(
  tx: TransactionalDb,
  companionsTable: string,
  agentId: string,
  companionId: string,
): Promise<BrowserCompanionCredential | null> {
  const rows = await executeRawSqlTx(
    tx,
    `SELECT *
       FROM ${companionsTable}
      WHERE agent_id = ${sqlQuote(agentId)}
        AND id = ${sqlQuote(companionId)}
      FOR UPDATE`,
  );
  return rows[0] ? parseBrowserCompanionCredential(rows[0]) : null;
}

export async function browserCompanionRevocationExists(
  tx: TransactionalDb,
  args: {
    agentId: string;
    ownerEntityId: string;
    browser: BrowserBridgeCompanionStatus["browser"];
    profileId: string;
  },
): Promise<boolean> {
  const rows = await executeRawSqlTx(
    tx,
    `SELECT 1
       FROM app_lifeops.life_browser_companion_revocations
      WHERE agent_id = ${sqlQuote(args.agentId)}
        AND owner_entity_id = ${sqlQuote(args.ownerEntityId)}
        AND browser = ${sqlQuote(args.browser)}
        AND profile_id IN (
          ${sqlQuote(args.profileId)},
          ${sqlQuote(BROWSER_COMPANION_WILDCARD_PROFILE_ID)}
        )
      LIMIT 1`,
  );
  return rows.length > 0;
}

export function parseBrowserTabSummary(
  row: Record<string, unknown>,
): BrowserBridgeTabSummary {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    companionId: row.companion_id ? toText(row.companion_id) : null,
    browser: toText(row.browser) as BrowserBridgeTabSummary["browser"],
    profileId: toText(row.profile_id),
    windowId: toText(row.window_id),
    tabId: toText(row.tab_id),
    url: toText(row.url),
    title: toText(row.title),
    activeInWindow: toBoolean(row.active_in_window, false),
    focusedWindow: toBoolean(row.focused_window, false),
    focusedActive: toBoolean(row.focused_active, false),
    incognito: toBoolean(row.incognito, false),
    faviconUrl: row.favicon_url ? toText(row.favicon_url) : null,
    lastSeenAt: toText(row.last_seen_at),
    lastFocusedAt: row.last_focused_at ? toText(row.last_focused_at) : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function parseBrowserPageContext(
  row: Record<string, unknown>,
): BrowserBridgePageContext {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    browser: toText(row.browser) as BrowserBridgePageContext["browser"],
    profileId: toText(row.profile_id),
    windowId: toText(row.window_id),
    tabId: toText(row.tab_id),
    url: toText(row.url),
    title: toText(row.title),
    selectionText: row.selection_text ? toText(row.selection_text) : null,
    mainText: row.main_text ? toText(row.main_text) : null,
    headings: parseJsonArray(row.headings_json).filter(
      (candidate): candidate is string => typeof candidate === "string",
    ),
    links: parseJsonArray(row.links_json).filter(
      (candidate): candidate is BrowserBridgePageContext["links"][number] =>
        (() => {
          if (!candidate || typeof candidate !== "object") {
            return false;
          }
          const record = candidate as Record<string, unknown>;
          return (
            typeof record.href === "string" && typeof record.text === "string"
          );
        })(),
    ),
    forms: parseJsonArray(row.forms_json).filter(
      (candidate): candidate is BrowserBridgePageContext["forms"][number] =>
        (() => {
          if (!candidate || typeof candidate !== "object") {
            return false;
          }
          const record = candidate as Record<string, unknown>;
          return (
            (record.action === null ||
              record.action === undefined ||
              typeof record.action === "string") &&
            Array.isArray(record.fields) &&
            record.fields.every((field) => typeof field === "string")
          );
        })(),
    ),
    capturedAt: toText(row.captured_at),
    metadata: parseJsonRecord(row.metadata_json),
  };
}

export function createLifeOpsBrowserSession(
  params: Omit<LifeOpsBrowserSession, "id" | "createdAt" | "updatedAt">,
): LifeOpsBrowserSession {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
