// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  APP_EMOTE_EVENT,
  createNavigateViewEvent,
  dispatchAppEmoteEvent,
  dispatchElizaCloudStatusUpdated,
  dispatchNavigateViewEvent,
  ELIZA_CLOUD_STATUS_UPDATED_EVENT,
  NAVIGATE_VIEW_EVENT,
} from "./index";

describe("UI event dispatch", () => {
  it("delivers navigation details to the host window", () => {
    const detail = { viewId: "settings", source: "user" as const };
    const event = createNavigateViewEvent(detail);
    expect(event.type).toBe(NAVIGATE_VIEW_EVENT);
    expect(event.detail).toBe(detail);
    let received: unknown;
    window.addEventListener(
      NAVIGATE_VIEW_EVENT,
      (value) => {
        received = (value as CustomEvent).detail;
      },
      { once: true },
    );
    dispatchNavigateViewEvent(detail);
    expect(received).toBe(detail);
  });

  it("preserves emote and cloud status payloads", () => {
    const emote = {
      emoteId: "wave",
      path: "/wave.vrma",
      duration: 1,
      loop: false,
    };
    const status = {
      connected: true,
      enabled: true,
      hasPersistedApiKey: true,
      cloudVoiceProxyAvailable: false,
    };
    const received: unknown[] = [];
    for (const name of [APP_EMOTE_EVENT, ELIZA_CLOUD_STATUS_UPDATED_EVENT]) {
      window.addEventListener(
        name,
        (event) => {
          received.push((event as CustomEvent).detail);
        },
        { once: true },
      );
    }
    dispatchAppEmoteEvent(emote);
    dispatchElizaCloudStatusUpdated(status);
    expect(received).toEqual([emote, status]);
    expect(received[0]).toBe(emote);
    expect(received[1]).toBe(status);
  });
});
