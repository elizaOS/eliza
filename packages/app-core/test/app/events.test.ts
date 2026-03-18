// @vitest-environment jsdom

import {
  AGENT_READY_EVENT,
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  BRIDGE_READY_EVENT,
  COMMAND_PALETTE_EVENT,
  CONNECT_EVENT,
  dispatchElizaEvent,
  dispatchWindowEvent,
  EMOTE_PICKER_EVENT,
  type ElizaDocumentEventName,
  type ElizaWindowEventName,
  SELF_STATUS_SYNC_EVENT,
  SHARE_TARGET_EVENT,
  STOP_EMOTE_EVENT,
  TRAY_ACTION_EVENT,
  VOICE_CONFIG_UPDATED_EVENT,
} from "@elizaos/app-core/events";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

describe("event constants", () => {
  it("exports all expected eliza:* event names", () => {
    expect(COMMAND_PALETTE_EVENT).toBe("eliza:command-palette");
    expect(EMOTE_PICKER_EVENT).toBe("eliza:emote-picker");
    expect(STOP_EMOTE_EVENT).toBe("eliza:stop-emote");
    expect(AGENT_READY_EVENT).toBe("eliza:agent-ready");
    expect(BRIDGE_READY_EVENT).toBe("eliza:bridge-ready");
    expect(SHARE_TARGET_EVENT).toBe("eliza:share-target");
    expect(TRAY_ACTION_EVENT).toBe("eliza:tray-action");
    expect(APP_RESUME_EVENT).toBe("eliza:app-resume");
    expect(APP_PAUSE_EVENT).toBe("eliza:app-pause");
    expect(CONNECT_EVENT).toBe("eliza:connect");
    expect(VOICE_CONFIG_UPDATED_EVENT).toBe("eliza:voice-config-updated");
    expect(SELF_STATUS_SYNC_EVENT).toBe("eliza:self-status-refresh");
  });
});

describe("dispatchElizaEvent", () => {
  it("accepts only known document event names", () => {
    expectTypeOf(dispatchElizaEvent)
      .parameter(0)
      .toEqualTypeOf<ElizaDocumentEventName>();
  });

  it("dispatches a CustomEvent on document", () => {
    const handler = vi.fn();
    document.addEventListener(COMMAND_PALETTE_EVENT, handler);
    dispatchElizaEvent(COMMAND_PALETTE_EVENT);
    expect(handler).toHaveBeenCalledTimes(1);
    document.removeEventListener(COMMAND_PALETTE_EVENT, handler);
  });

  it("includes detail when provided", () => {
    const handler = vi.fn();
    document.addEventListener(AGENT_READY_EVENT, handler);
    dispatchElizaEvent(AGENT_READY_EVENT, { state: "running" });
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ state: "running" });
    document.removeEventListener(AGENT_READY_EVENT, handler);
  });
});

describe("dispatchWindowEvent", () => {
  it("accepts only known window event names", () => {
    expectTypeOf(dispatchWindowEvent)
      .parameter(0)
      .toEqualTypeOf<ElizaWindowEventName>();
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
