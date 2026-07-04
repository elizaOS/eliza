// @vitest-environment jsdom

// Unit coverage for the plugin-owned Contacts navigate helpers (#12674): each
// helper dispatches the shared navigate-view event with the target view id and
// the deep-link payload shape that view claims. Real event bus, no mocks — the
// generic core channel replaced the old hardcoded Phone/Messages special case.

import { afterEach, describe, expect, it } from "vitest";
import {
  navigateToMessagesWithNumber,
  navigateToPhoneWithNumber,
} from "./contacts-navigate.ts";

function captureNavigateEvents(run: () => void): CustomEvent[] {
  const events: CustomEvent[] = [];
  const listener = (e: Event) => events.push(e as CustomEvent);
  window.addEventListener("eliza:navigate:view", listener);
  try {
    run();
  } finally {
    window.removeEventListener("eliza:navigate:view", listener);
  }
  return events;
}

describe("Contacts navigate helpers", () => {
  afterEach(() => {
    // The window bus is process-global; nothing to reset, but keep the hook so
    // added assertions on module state stay isolated.
  });

  it("navigateToPhoneWithNumber opens the Phone view pre-seeding the dialer", () => {
    const events = captureNavigateEvents(() =>
      navigateToPhoneWithNumber("+15550100"),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({
      viewId: "phone",
      viewPath: "/phone",
      payload: { number: "+15550100" },
    });
  });

  it("navigateToMessagesWithNumber opens the Messages view pre-seeding the composer", () => {
    const events = captureNavigateEvents(() =>
      navigateToMessagesWithNumber("+15550100"),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({
      viewId: "messages",
      viewPath: "/messages",
      payload: { recipient: "+15550100" },
    });
  });
});
