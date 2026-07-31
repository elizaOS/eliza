/**
 * Projects non-secret connector configuration across the Character boot
 * boundary while moving Slack credentials into the encrypted secret map.
 * Account overrides are split recursively because their tokens are just as
 * sensitive as the top-level account credentials.
 */
import type { JsonValue } from "@elizaos/core";

export const SLACK_CONNECTOR_CREDENTIALS_SECRET =
  "SLACK_CONNECTOR_CREDENTIALS_JSON";

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
    merged.accounts = {
      ...(baseAccounts ?? {}),
      ...(overrideAccounts ?? {}),
    };
  }
  return merged;
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
    secrets:
      Object.keys(credentials).length > 0
        ? {
            [SLACK_CONNECTOR_CREDENTIALS_SECRET]: JSON.stringify(credentials),
          }
        : {},
  };
}
