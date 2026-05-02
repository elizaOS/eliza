/**
 * Connector deep-link bus.
 *
 * Lets any caller ask SettingsView to scroll a specific connector panel into
 * view. Used by:
 *   - AutomationsView's missing-credentials banner ("Connect Gmail →" button)
 *   - The `eliza://settings/connectors/<provider>` external URL handler
 *     in apps/app/src/main.tsx
 *
 * Consumer side: SettingsView listens for SETTINGS_FOCUS_CONNECTOR_EVENT and
 * scrolls/highlights the matching `[data-connector="<provider>"]` element.
 *
 * The credType↔provider↔label mapping lives in `@elizaos/shared`'s
 * `connector-cred-types` module — single source of truth shared with the
 * server-side disconnect-purge path.
 */

export { prettyCredName, providerFromCredType } from "@elizaos/shared";

export const SETTINGS_FOCUS_CONNECTOR_EVENT = "eliza:settings:focus-connector";

export interface SettingsFocusConnectorDetail {
  /** Canonical provider id matching `data-connector="..."` on a panel wrapper. */
  provider: string;
}

/**
 * Pending provider stash. The dispatcher writes here unconditionally so a
 * SettingsView that has not yet mounted can drain it on mount (and drop the
 * timing race against React's render scheduler). The event still fires for
 * the case where SettingsView is already mounted and listening — first
 * delivery wins; the drain on mount is the fallback.
 *
 * Module-scoped because it bridges call sites that don't share React context
 * (`apps/app/src/main.tsx` URL handler ↔ AutomationsView click handler ↔
 * SettingsView mount).
 */
let pendingFocusProvider: string | null = null;

export function dispatchFocusConnector(provider: string): void {
  pendingFocusProvider = provider;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SettingsFocusConnectorDetail>(
      SETTINGS_FOCUS_CONNECTOR_EVENT,
      { detail: { provider } },
    ),
  );
}

/**
 * Read and clear the pending focus target. Called by SettingsView on mount
 * so the focus survives a render cycle when the dispatch happened before
 * the listener was registered.
 */
export function consumePendingFocusProvider(): string | null {
  const provider = pendingFocusProvider;
  pendingFocusProvider = null;
  return provider;
}
