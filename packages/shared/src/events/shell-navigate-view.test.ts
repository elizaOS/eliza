/**
 * Shell navigate-view event contract (from events/index): the
 * eliza:navigate:view DOM CustomEvent factory and its name constant, payload
 * normalization (valid fields kept, malformed optionals dropped, non-string
 * view ids filtered out), and the websocket frame builder. Pure contract
 * assertions, with no DOM or socket harness.
 */
import { describe, expect, it } from "vitest";
import {
  createNavigateViewEvent,
  createShellNavigateViewWsFrame,
  NAVIGATE_VIEW_EVENT,
  normalizeShellNavigateViewPayload,
  SHELL_NAVIGATE_VIEW_WS_EVENT,
} from "./index";

describe("shell navigate view websocket event", () => {
  it("exports the app navigate-view DOM event contract", () => {
    const event = createNavigateViewEvent({
      viewId: "wallet",
      viewPath: "/wallet",
      subview: "activity",
    });

    expect(NAVIGATE_VIEW_EVENT).toBe("eliza:navigate:view");
    expect(event.type).toBe(NAVIGATE_VIEW_EVENT);
    expect(event.detail).toEqual({
      viewId: "wallet",
      viewPath: "/wallet",
      subview: "activity",
    });
  });

  it("normalizes valid navigation fields", () => {
    expect(
      normalizeShellNavigateViewPayload({
        viewId: "wallet",
        viewPath: "/wallet",
        viewLabel: "Wallet",
        viewType: "xr",
        action: "show",
        subview: "activity",
        views: ["wallet", "", "inbox", 3],
        layout: "split",
        placement: "right",
        alwaysOnTop: true,
      }),
    ).toEqual({
      viewId: "wallet",
      viewPath: "/wallet",
      viewLabel: "Wallet",
      viewType: "xr",
      action: "show",
      subview: "activity",
      views: ["wallet", "inbox"],
      layout: "split",
      placement: "right",
      alwaysOnTop: true,
    });
  });

  it("drops malformed optional fields without changing the event name", () => {
    expect(
      createShellNavigateViewWsFrame(
        normalizeShellNavigateViewPayload({
          viewId: 12,
          viewType: "spatial",
          subview: "",
          views: [null, ""],
          alwaysOnTop: "yes",
        }),
      ),
    ).toEqual({
      type: SHELL_NAVIGATE_VIEW_WS_EVENT,
      viewId: undefined,
      viewPath: undefined,
      viewLabel: undefined,
      viewType: undefined,
      action: undefined,
      subview: undefined,
      views: undefined,
      layout: undefined,
      placement: undefined,
      alwaysOnTop: false,
    });
  });
});
