// @vitest-environment jsdom

import {
  AGENT_READY_EVENT,
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  BRIDGE_READY_EVENT,
  COMMAND_PALETTE_EVENT,
  CONNECT_EVENT,
  dispatchMiladyEvent,
  dispatchWindowEvent,
  EMOTE_PICKER_EVENT,
  type MiladyDocumentEventName,
  type MiladyWindowEventName,
  SELF_STATUS_SYNC_EVENT,
  SHARE_TARGET_EVENT,
  STOP_EMOTE_EVENT,
  TRAY_ACTION_EVENT,
  VOICE_CONFIG_UPDATED_EVENT,
} from "@elizaos/app-core/events";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

describe("event constants", () => {
  it("exports all expected milady:* event names", () => {
    expect(COMMAND_PALETTE_EVENT).toBe("milady:command-palette");
    expect(EMOTE_PICKER_EVENT).toBe("milady:emote-picker");
    expect(STOP_EMOTE_EVENT).toBe("milady:stop-emote");
    expect(AGENT_READY_EVENT).toBe("milady:agent-ready");
    expect(BRIDGE_READY_EVENT).toBe("milady:bridge-ready");
    expect(SHARE_TARGET_EVENT).toBe("milady:share-target");
    expect(TRAY_ACTION_EVENT).toBe("milady:tray-action");
    expect(APP_RESUME_EVENT).toBe("milady:app-resume");
    expect(APP_PAUSE_EVENT).toBe("milady:app-pause");
    expect(CONNECT_EVENT).toBe("milady:connect");
    expect(VOICE_CONFIG_UPDATED_EVENT).toBe("milady:voice-config-updated");
    expect(SELF_STATUS_SYNC_EVENT).toBe("milady:self-status-refresh");
  });
});

describe("dispatchMiladyEvent", () => {
  it("accepts only known document event names", () => {
    expectTypeOf(dispatchMiladyEvent)
      .parameter(0)
      .toEqualTypeOf<MiladyDocumentEventName>();
  });

  it("dispatches a CustomEvent on document", () => {
    const handler = vi.fn();
    document.addEventListener(COMMAND_PALETTE_EVENT, handler);
    dispatchMiladyEvent(COMMAND_PALETTE_EVENT);
    expect(handler).toHaveBeenCalledTimes(1);
    document.removeEventListener(COMMAND_PALETTE_EVENT, handler);
  });

  it("includes detail when provided", () => {
    const handler = vi.fn();
    document.addEventListener(AGENT_READY_EVENT, handler);
    dispatchMiladyEvent(AGENT_READY_EVENT, { state: "running" });
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ state: "running" });
    document.removeEventListener(AGENT_READY_EVENT, handler);
  });
});

describe("dispatchWindowEvent", () => {
  it("accepts only known window event names", () => {
    expectTypeOf(dispatchWindowEvent)
      .parameter(0)
      .toEqualTypeOf<MiladyWindowEventName>();
  });

  it("dispatches a CustomEvent on window", () => {
    const handler = vi.fn();
    window.addEventListener(VOICE_CONFIG_UPDATED_EVENT, handler);
    dispatchWindowEvent(VOICE_CONFIG_UPDATED_EVENT, { provider: "test" });
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ provider: "test" });
    window.removeEventListener(VOICE_CONFIG_UPDATED_EVENT, handler);
  });

  it("dispatches sidebar refresh events on window", () => {
    const handler = vi.fn();
    window.addEventListener(SELF_STATUS_SYNC_EVENT, handler);
    dispatchWindowEvent(SELF_STATUS_SYNC_EVENT);
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(SELF_STATUS_SYNC_EVENT, handler);
  });
});
