/**
 * Single source of truth for connector ↔ workflow credential type mappings, the
 * inverse map from workflow credential type back to a canonical provider id, and
 * user-facing display labels.
 *
 * Used by:
 *   - `connector-routes.ts` POST `/api/connectors` disconnect path → maps a
 *     connector name to the credential types that need cache-purging.
 *   - `app-core` AutomationsView's missing-credentials banner →
 *     `prettyCredName(credType)` for the connect-button label.
 *   - `app-core` connector deep-link → `providerFromCredType(credType)` for
 *     the canonical provider id used as the `data-connector` attribute.
 *
 * Keep these aligned: each entry in CONNECTOR_CRED_TYPES should round-trip
 * through `providerFromCredType` (cred type → provider) and a
 * provider-friendly label (`PROVIDER_LABELS`).
 */

/**
 * Connector name (as stored in `eliza.json` connectors block) →
 * the workflow credential type ids it owns. Disconnecting this connector should
 * purge the credential cache for every credType in this list.
 */
export const CONNECTOR_CRED_TYPES: Readonly<Record<string, readonly string[]>> =
  {
    gmail: ["gmailOAuth2", "gmailOAuth2Api"],
    slack: ["slackApi", "slackOAuth2Api"],
    discord: ["discordApi", "discordBotApi", "discordWebhookApi"],
    telegram: ["telegramApi"],
  };

export function credTypesForConnector(
  connectorName: string,
): readonly string[] {
  return CONNECTOR_CRED_TYPES[connectorName] ?? [];
}

/**
 * Canonical provider id for a given workflow credential type. Falls back to a
 * lowercased credType when unknown so a forward-compatible response from a
 * new node still routes to *something* sensible.
 */
const CRED_TYPE_TO_PROVIDER: Readonly<Record<string, string>> = {
  gmailOAuth2: "gmail",
  gmailOAuth2Api: "gmail",
  slackApi: "slack",
  slackOAuth2Api: "slack",
  discordApi: "discord",
  discordBotApi: "discord",
  discordWebhookApi: "discord",
  telegramApi: "telegram",
};

export function providerFromCredType(credType: string): string {
  return CRED_TYPE_TO_PROVIDER[credType] ?? credType.toLowerCase();
}

/**
 * User-facing display label per provider id. Used to render
 * "Connect <Provider> →" buttons.
 */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  gmail: "Gmail",
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
};

export function prettyCredName(credType: string): string {
  const provider = providerFromCredType(credType);
  return PROVIDER_LABELS[provider] ?? credType;
}
