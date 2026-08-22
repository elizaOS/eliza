/**
 * Non-revealing inventory of connector credentials that still live outside the
 * encrypted Vault. This module owns the connector-field policy shared by the
 * boot migrator and owner-only Vault API, so migration and visibility cannot
 * drift apart.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Top-level connector fields whose values are credential material and whose
 * runtime projection already supports `vault://` sentinels.
 */
export const CONNECTOR_SECRET_FIELDS: Readonly<
  Record<string, readonly string[]>
> = {
  bluebubbles: ["password"],
  discord: ["token", "botToken"],
  discordLocal: ["clientSecret"],
  telegram: ["botToken"],
  telegramAccount: ["appHash"],
  slack: ["botToken", "appToken", "userToken", "signingSecret"],
  msteams: ["appPassword"],
  mattermost: ["botToken"],
  googlechat: ["serviceAccountKey"],
  blooio: ["apiKey", "webhookSecret"],
};

export function connectorVaultKey(
  connectorName: string,
  fieldName: string,
): string {
  return `connector.host.${connectorName}.default.${fieldName}`;
}

export interface ConnectorSecretFinding {
  id: string;
  connector: string;
  label: string;
  source: "eliza-config" | "state-file";
  protection: "mode-0600" | "permissions-need-attention";
  autoMigratesOnDesktop: boolean;
  detail: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlaintextCredential(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.startsWith("vault://")
  );
}

function configFinding(
  connector: string,
  field: string,
  accountId?: string,
): ConnectorSecretFinding {
  const account = accountId ? ` account ${accountId}` : "";
  const suffix = accountId ? `.accounts.${accountId}.${field}` : `.${field}`;
  return {
    id: `config:${connector}${suffix}`,
    connector,
    label: `${connector}${account} ${field}`,
    source: "eliza-config",
    protection: "mode-0600",
    autoMigratesOnDesktop: accountId === undefined,
    detail:
      accountId === undefined
        ? "Stored in the access-controlled config fallback; desktop boot can move it into encrypted Vault storage."
        : "Stored in a nested account config; encrypted multi-account migration is not available yet.",
  };
}

function stateFileFinding(
  id: string,
  label: string,
  filePath: string,
): ConnectorSecretFinding | null {
  if (!existsSync(filePath)) return null;
  let mode: number;
  try {
    mode = statSync(filePath).mode & 0o777;
  } catch {
    // The connector can remove login state while inventory is being read.
    // Treat that race as an absent finding instead of failing the owner API.
    return null;
  }
  return {
    id,
    connector: "telegram-account",
    label,
    source: "state-file",
    protection: mode === 0o600 ? "mode-0600" : "permissions-need-attention",
    autoMigratesOnDesktop: false,
    detail:
      mode === 0o600
        ? "Protected by local file permissions, but not encrypted by Vault. Disconnect Telegram Personal to remove it."
        : "File permissions are broader than 0600. Disconnect Telegram Personal and re-authenticate before reuse.",
  };
}

/** Return names and protection status only; secret values never leave config. */
export function listConnectorSecretFindings(
  config: Record<string, unknown>,
  stateDir: string,
): ConnectorSecretFinding[] {
  const findings: ConnectorSecretFinding[] = [];
  const connectorsValue = config.connectors ?? config.channels;
  if (isPlainRecord(connectorsValue)) {
    for (const [connector, secretFields] of Object.entries(
      CONNECTOR_SECRET_FIELDS,
    )) {
      const connectorConfig = connectorsValue[connector];
      if (!isPlainRecord(connectorConfig)) continue;
      for (const field of secretFields) {
        if (isPlaintextCredential(connectorConfig[field])) {
          findings.push(configFinding(connector, field));
        }
      }
      const accounts = connectorConfig.accounts;
      if (!isPlainRecord(accounts)) continue;
      for (const [accountId, accountValue] of Object.entries(accounts)) {
        if (!isPlainRecord(accountValue)) continue;
        for (const field of secretFields) {
          if (isPlaintextCredential(accountValue[field])) {
            findings.push(configFinding(connector, field, accountId));
          }
        }
      }
    }
  }

  const telegramStateDir = join(stateDir, "telegram-account");
  const session = stateFileFinding(
    "state:telegram-account:session",
    "Telegram Personal session",
    join(telegramStateDir, "session.txt"),
  );
  if (session) findings.push(session);
  const authState = stateFileFinding(
    "state:telegram-account:auth",
    "Telegram Personal login state",
    join(telegramStateDir, "auth-state.json"),
  );
  if (authState) findings.push(authState);

  return findings;
}
