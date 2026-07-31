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
        deliveryOwner: "outbox",
        operationId: "views:op-7",
        operationRevision: 3,
        viewId: "wallet",
        viewPath: "/wallet",
        viewLabel: "Wallet",
        viewType: "xr",
        action: "open-window",
        subview: "activity",
        views: ["wallet", "", "inbox", 3],
        panes: [
          { viewId: "wallet", viewType: "xr" },
          { viewId: "wallet", viewType: "gui" },
        ],
        layout: "split",
        placement: "right",
        alwaysOnTop: true,
        source: "agent",
        revision: 7,
        payload: { permissionRequest: { permission: "microphone" } },
      }),
    ).toEqual({
      deliveryOwner: "outbox",
      operationId: "views:op-7",
      operationRevision: 3,
      viewId: "wallet",
      viewPath: "/wallet",
      viewLabel: "Wallet",
      viewType: "xr",
      action: "open-window",
      subview: "activity",
      views: ["wallet", "inbox"],
      panes: [
        { viewId: "wallet", viewType: "xr" },
        { viewId: "wallet", viewType: "gui" },
      ],
      layout: "split",
      placement: "right",
      alwaysOnTop: true,
      source: "agent",
      revision: 7,
      payload: { permissionRequest: { permission: "microphone" } },
    });
  });

  it("rejects the entire pane topology when a middle pane is malformed", () => {
    expect(() =>
      normalizeShellNavigateViewPayload({
        viewId: "wallet",
        panes: [
          { viewId: "wallet", viewType: "gui" },
          { viewId: "", viewType: "tui" },
          { viewId: "calendar", viewType: "gui" },
        ],
      }),
    ).toThrow("Malformed shell navigation panes");
  });

  it.each([
    { deliveryOwner: "outbox", operationId: "views:op-7" },
    { deliveryOwner: "outbox", operationRevision: 3 },
    {
      deliveryOwner: "outbox",
      operationId: "views:op-7",
      operationRevision: 0,
    },
    { deliveryOwner: "outbox", operationId: "bad id", operationRevision: 3 },
    {
      deliveryOwner: "outbox",
      operationId: "x".repeat(129),
      operationRevision: 3,
    },
    {
      deliveryOwner: "outbox",
      operationId: "views:op-7",
      operationRevision: 3,
      viewId: "calendar",
      viewType: "gui",
      revision: 1,
      action: "split-view",
    },
  ])("rejects a partial or malformed operation receipt: %j", (operation) => {
    expect(() => normalizeShellNavigateViewPayload(operation)).toThrow(
      "Malformed shell navigation operation",
    );
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
          source: "system",
          revision: -1,
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
      panes: undefined,
      layout: undefined,
      placement: undefined,
      alwaysOnTop: false,
      source: undefined,
      revision: undefined,
    });
  });
});
