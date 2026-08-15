/**
 * Projects non-secret connector configuration across the Character boot
 * boundary while moving Slack credentials into the encrypted secret map.
 * Account overrides are split recursively because their tokens are just as
 * sensitive as the top-level account credentials.
 *
 * `vault://` refs are stripped from both lanes rather than projected: they are
 * pointers, not secret material, and the boot chain (`collectConnectorEnvVars`
 * → `resolveConnectorSecretSettings` → `buildRuntimeSettingsProjection`)
 * resolves them into env-keyed runtime settings that the Slack account
 * resolver already consults as its fallback.
 */
import {
  connectorAccountCredentialSettingKey,
  connectorBaseCredentialSettingKey,
  type JsonValue,
} from "@elizaos/core";

import { isVaultRef } from "./operations/vault-bridge.ts";

const SLACK_CREDENTIAL_KEYS = new Set([
  "appToken",
  "botToken",
  "signingSecret",
  "userToken",
]);

interface SlackProjection {
  policy: Record<string, JsonValue>;
  credentials: Record<string, JsonValue>;
}

export interface ConnectorSettingsProjection {
  settings: Record<string, JsonValue | undefined>;
  secrets: Record<string, string>;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function splitSlackConfig(value: Record<string, JsonValue>): SlackProjection {
  const policy: Record<string, JsonValue> = {};
  const credentials: Record<string, JsonValue> = {};

  for (const [key, raw] of Object.entries(value)) {
    if (SLACK_CREDENTIAL_KEYS.has(key)) {
      credentials[key] = structuredClone(raw);
      continue;
    }
    if (key !== "accounts" || !isJsonObject(raw)) {
      policy[key] = structuredClone(raw);
      continue;
    }

    const policyAccounts: Record<string, JsonValue> = {};
    const credentialAccounts: Record<string, JsonValue> = {};
    for (const [accountId, account] of Object.entries(raw)) {
      if (!isJsonObject(account)) continue;
      const split = splitSlackConfig(account);
      policyAccounts[accountId] = split.policy;
      if (Object.keys(split.credentials).length > 0) {
        credentialAccounts[accountId] = split.credentials;
      }
    }
    policy.accounts = policyAccounts;
    if (Object.keys(credentialAccounts).length > 0) {
      credentials.accounts = credentialAccounts;
    }
  }

  return { policy, credentials };
}

function mergeSlackProjection(
  base: Record<string, JsonValue>,
  override: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const baseAccounts = isJsonObject(base.accounts) ? base.accounts : undefined;
  const overrideAccounts = isJsonObject(override.accounts)
    ? override.accounts
    : undefined;
  const merged = { ...base, ...override };
  if (baseAccounts || overrideAccounts) {
    const accountIds = new Set([
      ...Object.keys(baseAccounts ?? {}),
      ...Object.keys(overrideAccounts ?? {}),
    ]);
    merged.accounts = Object.fromEntries(
      [...accountIds].map((accountId) => {
        const baseAccount = baseAccounts?.[accountId];
        const overrideAccount = overrideAccounts?.[accountId];
        return [
          accountId,
          {
            ...(isJsonObject(baseAccount) ? baseAccount : {}),
            ...(isJsonObject(overrideAccount) ? overrideAccount : {}),
          },
        ];
      }),
    );
  }
  return merged;
}

function projectSlackCredentialSecrets(
  credentials: Record<string, JsonValue>,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const field of SLACK_CREDENTIAL_KEYS) {
    const value = credentials[field];
    if (typeof value === "string" && value.trim() && !isVaultRef(value)) {
      secrets[connectorBaseCredentialSettingKey("slack", field)] = value;
    }
  }
  const accounts = isJsonObject(credentials.accounts)
    ? credentials.accounts
    : {};
  for (const [accountId, rawAccount] of Object.entries(accounts)) {
    if (!isJsonObject(rawAccount)) continue;
    for (const field of SLACK_CREDENTIAL_KEYS) {
      const value = rawAccount[field];
      if (typeof value === "string" && value.trim() && !isVaultRef(value)) {
        secrets[
          connectorAccountCredentialSettingKey("slack", accountId, field)
        ] = value;
      }
    }
  }
  return secrets;
}

export function projectConnectorSettings(
  settings: Record<string, JsonValue | undefined>,
  connectors: unknown,
): ConnectorSettingsProjection {
  const configuredSlack = isJsonObject(connectors)
    ? connectors.slack
    : undefined;
  const settingsSlack = settings.slack;
  const configured = isJsonObject(configuredSlack)
    ? splitSlackConfig(configuredSlack)
    : { policy: {}, credentials: {} };
  const injected = isJsonObject(settingsSlack)
    ? splitSlackConfig(settingsSlack)
    : { policy: {}, credentials: {} };
  const policy = mergeSlackProjection(configured.policy, injected.policy);
  const credentials = mergeSlackProjection(
    configured.credentials,
    injected.credentials,
  );
  const hasSlack = isJsonObject(configuredSlack) || isJsonObject(settingsSlack);

  return {
    settings: {
      ...settings,
      ...(hasSlack ? { slack: policy } : {}),
    },
    secrets: projectSlackCredentialSecrets(credentials),
  };
}
