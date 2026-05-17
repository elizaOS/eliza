/**
 * view-event-types.ts
 *
 * Standard event type string constants for the view event bus.
 * Import these instead of using raw strings to avoid typos and aid refactors.
 */
export declare const VIEW_EVENTS: {
  /** A wallet balance or token list changed. */
  readonly WALLET_BALANCE_UPDATED: "wallet:balance:updated";
  /** Agent requests the shell to navigate to a view. */
  readonly AGENT_NAVIGATE: "agent:navigate:view";
  /** Ask a specific (or all) view(s) to reload their data. */
  readonly VIEW_REFRESH: "view:refresh";
  /** A view gained focus / became visible. */
  readonly VIEW_FOCUSED: "view:focused";
  /** A view lost focus / became hidden. */
  readonly VIEW_BLURRED: "view:blurred";
  /** A blockchain / payment transaction completed successfully. */
  readonly TRANSACTION_COMPLETE: "transaction:complete";
  /** A user-facing setting was changed and persisted. */
  readonly SETTINGS_CHANGED: "settings:changed";
};
export type ViewEventType = (typeof VIEW_EVENTS)[keyof typeof VIEW_EVENTS];
//# sourceMappingURL=view-event-types.d.ts.map
