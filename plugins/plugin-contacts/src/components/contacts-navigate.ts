/**
 * Plugin-owned navigate helpers for the Contacts surface's Call/Text handoffs.
 *
 * Contacts owns no Phone or Messages view, so it hands off intent through the
 * shared navigate-view bus: it constructs the deep-link payload the target
 * view's own `consumeNavigateViewPayload<T>()` claims on mount. The payload
 * shapes here (`{ number }` for the Phone dialer, `{ recipient }` for the
 * Messages composer) are the contract those views read; the shared core
 * (`@elizaos/ui/app-navigate-view`) stays generic and names no view id. Keeping
 * this next to the components that call it — rather than in the shared core —
 * is the point of the #12674 audit item.
 */

import { dispatchNavigateViewEvent } from "@elizaos/ui/events";

/** Deep-link payload the Phone view claims to pre-seed its dialer. */
export type PhoneNavigatePayload = { number: string };

/** Deep-link payload the Messages view claims to pre-seed its composer "To". */
export type MessagesNavigatePayload = { recipient: string };

/** Open the Phone view via the navigation bus, pre-seeding the dialer. */
export function navigateToPhoneWithNumber(number: string): void {
  const payload: PhoneNavigatePayload = { number };
  dispatchNavigateViewEvent({ viewId: "phone", viewPath: "/phone", payload });
}

/** Open the Messages view via the navigation bus, pre-seeding the composer. */
export function navigateToMessagesWithNumber(recipient: string): void {
  const payload: MessagesNavigatePayload = { recipient };
  dispatchNavigateViewEvent({
    viewId: "messages",
    viewPath: "/messages",
    payload,
  });
}
