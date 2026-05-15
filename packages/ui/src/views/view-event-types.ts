/**
 * view-event-types.ts
 *
 * Standard event type string constants for the view event bus.
 * Import these instead of using raw strings to avoid typos and aid refactors.
 */

export const VIEW_EVENTS = {
  /** A wallet balance or token list changed. */
  WALLET_BALANCE_UPDATED: "wallet:balance:updated",
  /** Agent requests the shell to navigate to a view. */
  AGENT_NAVIGATE: "agent:navigate:view",
  /** Ask a specific (or all) view(s) to reload their data. */
  VIEW_REFRESH: "view:refresh",
  /** A view gained focus / became visible. */
  VIEW_FOCUSED: "view:focused",
  /** A view lost focus / became hidden. */
  VIEW_BLURRED: "view:blurred",
  /** A blockchain / payment transaction completed successfully. */
  TRANSACTION_COMPLETE: "transaction:complete",
  /** A user-facing setting was changed and persisted. */
  SETTINGS_CHANGED: "settings:changed",
} as const;

export type ViewEventType = (typeof VIEW_EVENTS)[keyof typeof VIEW_EVENTS];
