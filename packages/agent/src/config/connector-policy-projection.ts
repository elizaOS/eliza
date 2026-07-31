/**
 * Credential/policy separation for the connector config projected onto a
 * Character.
 *
 * A connector plugin needs its structured POLICY (channels, DM rules,
 * groupPolicy, mention defaults) on `character.settings.<connector>` in order
 * to enforce anything. It must NOT receive the connector's CREDENTIALS there:
 * `character.settings.secrets` is the boundary the runtime's redactor scans
 * (`buildSecretSwapSession`), so a token that lands in plain settings is a
 * token that can be echoed into model output, logs, and exports.
 *
 * `SlackAccountSchema` carries `botToken` / `appToken` / `userToken` /
 * `signingSecret` at BOTH the base level and inside every `accounts.<id>`
 * entry, so projecting the canonical `connectors.slack` object wholesale would
 * move all of them across that boundary. This module is the typed
 * credential-free view instead:
 *
 *   - `projectConnectorPolicy()` returns a DEEP CLONE with every
 *     credential-classified key removed AT ANY DEPTH. It is deny-by-predicate
 *     rather than strip-a-known-list, so a credential field added to the schema
 *     later is excluded by default instead of silently leaking.
 *   - The credentials it removes are not discarded: per-account values are
 *     hoisted to deterministic secret keys so they keep flowing through the
 *     redactable secret path and multi-account deployments keep working.
 *
 * The classifier is the repo's own `isSensitiveConfigKey`, the same predicate
 * that drives config-API redaction, so "what counts as a credential" has one
 * definition rather than two that can drift.
 */
import {
  connectorAccountCredentialSettingKey,
  connectorBaseCredentialSettingKey,
  type JsonObject,
  type JsonValue,
} from "@elizaos/core";
import { isSensitiveConfigKey } from "./sensitive-keys.ts";
import {
  SlackAccountSchema,
  SlackConfigSchema,
} from "./zod-schema.providers-core.ts";

/** Connectors whose structured policy is projected onto character settings. */
export const PROJECTED_CONNECTOR_KEYS = ["slack"] as const;
export type ProjectedConnectorKey = (typeof PROJECTED_CONNECTOR_KEYS)[number];

/**
 * Credential-bearing fields of a Slack account, derived FROM THE SCHEMA rather
 * than hand-listed, so the set cannot drift out of sync with
 * `SlackAccountSchema`. Exported for the exact-schema test that asserts none of
 * these ever appear in plain character settings.
 */
export const SLACK_CREDENTIAL_FIELDS: readonly string[] = Object.freeze(
  Object.keys(SlackAccountSchema.shape).filter((key) =>
    isSensitiveConfigKey(key),
  ),
);

/**
 * Non-credential fields of a Slack account: everything the policy resolver is
 * entitled to see. Exported for the exact-schema test that asserts each one
 * still reaches the plugin.
 */
export const SLACK_POLICY_FIELDS: readonly string[] = Object.freeze(
  Object.keys(SlackConfigSchema.shape).filter(
    (key) => !isSensitiveConfigKey(key),
  ),
);

/**
 * Secret key holding a per-account Slack credential.
 *
 * Base-level credentials already reach `character.settings.secrets` through the
 * existing env lane (`collectConnectorEnvVars` maps `connectors.slack.botToken`
 * to `SLACK_BOT_TOKEN`, which `buildCharacterFromConfig` collects as a secret).
 * Per-account credentials had no such lane, which is why projecting them as
 * plain settings looked like the only way to make multi-account work. This
 * gives them their own key in the SECRET path instead.
 *
 * Each credential gets its own key deliberately: the redactor's known-secret
 * set is built from secret VALUES, so one key per token means every token is
 * individually redactable. Packing them into a single JSON blob (the older
 * `MATRIX_ACCOUNTS` pattern) only redacts the blob as a whole and lets an
 * individual token through.
 *
 * The key shape itself is defined once in @elizaos/core so the plugin reading
 * these secrets derives the identical string.
 */
export function slackAccountCredentialSettingKey(
  accountId: string,
  field: string,
): string {
  return connectorAccountCredentialSettingKey("slack", accountId, field);
}

/**
 * Secret key holding a BASE-LEVEL Slack credential.
 *
 * `SlackConfigSchema` is `SlackAccountSchema.extend({accounts})`, so a
 * top-level token is the credential every account inherits unless it overrides
 * it. That inheritance must survive credential stripping, and it cannot be
 * served by the flat `SLACK_BOT_TOKEN` env lane because that lane is
 * default-account-only by design.
 */
export function slackBaseCredentialSettingKey(field: string): string {
  return connectorBaseCredentialSettingKey("slack", field);
}

export interface ConnectorPolicyProjection {
  /**
   * Deep-cloned, credential-free policy safe to place in plain character
   * settings. `undefined` when the connector block is absent or not an object.
   */
  policy?: JsonObject;
  /**
   * Credential values keyed by the setting name they must be published under,
   * for the caller to merge into `character.settings.secrets`.
   */
  credentialSecrets: Record<string, string>;
}

/**
 * Builds the credential-free policy view for one connector block.
 *
 * The returned object shares NO structure with `raw`: the reviewed head
 * assigned the persisted object by reference, so a later mutation of character
 * settings would have written back into the loaded config (and vice versa).
 */
export function projectConnectorPolicy(
  connector: ProjectedConnectorKey,
  raw: unknown,
): ConnectorPolicyProjection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { credentialSecrets: {} };
  }

  const credentialSecrets: Record<string, string> = {};
  if (connector === "slack") {
    collectSlackCredentials(raw as Record<string, unknown>, credentialSecrets);
  }

  const policy = stripCredentials(raw) as JsonObject;
  return { policy, credentialSecrets };
}

/**
 * Hoists Slack credentials out of the config object into secret settings, so
 * stripping them from the projected policy loses no capability.
 *
 * Both levels are carried:
 *   - BASE (`connectors.slack.botToken`): the schema's inheritance source for
 *     every account. The flat `SLACK_BOT_TOKEN` env lane cannot stand in for
 *     this, because that lane is deliberately default-account-only.
 *   - PER-ACCOUNT (`connectors.slack.accounts.<id>.botToken`): never had any
 *     secret lane at all, which is what made plain-settings projection look
 *     like the only way to support multi-account.
 */
function collectSlackCredentials(
  slack: Record<string, unknown>,
  out: Record<string, string>,
): void {
  for (const field of SLACK_CREDENTIAL_FIELDS) {
    const value = slack[field];
    if (typeof value !== "string" || !value.trim()) continue;
    out[slackBaseCredentialSettingKey(field)] = value;
  }

  const accounts = slack.accounts;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) {
    return;
  }
  for (const [accountId, accountConfig] of Object.entries(
    accounts as Record<string, unknown>,
  )) {
    if (
      !accountConfig ||
      typeof accountConfig !== "object" ||
      Array.isArray(accountConfig)
    ) {
      continue;
    }
    const account = accountConfig as Record<string, unknown>;
    for (const field of SLACK_CREDENTIAL_FIELDS) {
      const value = account[field];
      if (typeof value !== "string" || !value.trim()) continue;
      out[slackAccountCredentialSettingKey(accountId, field)] = value;
    }
  }
}

/**
 * Recursively deep-clones `value`, dropping every key the shared classifier
 * considers a credential, at ANY depth.
 *
 * Depth-independence is the point: `accounts.<id>.botToken` is exactly as
 * dangerous as a top-level `botToken`, and a future nested credential (a
 * per-channel token, say) must not require this file to be updated to stay
 * closed.
 */
function stripCredentials(value: unknown): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => stripCredentials(entry));
  }
  if (value && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (isSensitiveConfigKey(key)) continue;
      if (entry === undefined) continue;
      out[key] = stripCredentials(entry);
    }
    return out;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value as JsonValue;
  }
  // Functions/symbols/undefined are not representable in a persisted config;
  // dropping them keeps the result a true JsonValue.
  return null;
}

/**
 * True when any credential-classified key survives anywhere in `value`.
 * Used as a post-condition assertion by tests and by the projection's callers.
 */
export function containsCredentialKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsCredentialKey(entry));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, entry]) =>
        isSensitiveConfigKey(key) || containsCredentialKey(entry),
    );
  }
  return false;
}
