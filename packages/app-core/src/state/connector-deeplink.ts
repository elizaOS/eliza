/**
 * Connector deep-link bus.
 *
 * Lets any caller ask SettingsView to scroll a specific connector panel into
 * view. Used by:
 *   - AutomationsView's missing-credentials banner ("Connect Gmail →" button)
 *   - The `milady://settings/connectors/<provider>` external URL handler
 *     in apps/app/src/main.tsx
 *
 * Consumer side: SettingsView listens for SETTINGS_FOCUS_CONNECTOR_EVENT and
 * scrolls/highlights the matching `[data-connector="<provider>"]` element.
 */

export const SETTINGS_FOCUS_CONNECTOR_EVENT = "milady:settings:focus-connector";

export interface SettingsFocusConnectorDetail {
  /** Canonical provider id matching `data-connector="..."` on a panel wrapper. */
  provider: string;
}

/**
 * Map an n8n credential type (slackOAuth2Api, gmailOAuth2, ...) to the
 * canonical provider id used as the deep-link target. Falls back to a
 * lowercased credType when unknown so a forward-compatible response from the
 * backend still routes to *something* sensible.
 */
const CRED_TYPE_TO_PROVIDER: Record<string, string> = {
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

export function dispatchFocusConnector(provider: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SettingsFocusConnectorDetail>(
      SETTINGS_FOCUS_CONNECTOR_EVENT,
      { detail: { provider } },
    ),
  );
}
