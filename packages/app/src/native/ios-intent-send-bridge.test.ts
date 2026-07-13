/**
 * Unit coverage for the iOS native auto-send bridge: the `nativeIntent`
 * Capacitor listener wiring and the send-message payload validation boundary.
 * The Capacitor plugin is a structural test double injected through the
 * bridge's deps seam — no module mocking.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetIosIntentSendBridgeForTests,
  type ElizaIntentEventsPluginLike,
  handleNativeIntentEvent,
  initializeIosIntentSendBridge,
  type NativeIntentEvent,
} from "./ios-intent-send-bridge";

type Dispatched = { text: string; source: string };

function makeRecorder() {
  const sends: Dispatched[] = [];
  const warnings: string[] = [];
  return {
    sends,
    warnings,
    dispatch: (detail: Dispatched) => sends.push(detail),
    warn: (message: string) => warnings.push(message),
  };
}

function makePlugin() {
  const handle: PluginListenerHandle = { remove: async () => {} };
  const calls: Array<{ eventName: string }> = [];
  let listener: ((event: NativeIntentEvent) => void) | null = null;
  const plugin: ElizaIntentEventsPluginLike = {
    addListener: (eventName, listenerFunc) => {
      calls.push({ eventName });
      listener = listenerFunc;
      return Promise.resolve(handle);
    },
  };
  return {
    plugin,
    calls,
    handle,
    emit: (event: NativeIntentEvent) => listener?.(event),
  };
}

describe("handleNativeIntentEvent", () => {
  it("dispatches a well-formed send-message payload", () => {
    const rec = makeRecorder();
    const handled = handleNativeIntentEvent(
      {
        action: "send-message",
        text: "hello eliza",
        source: "ios-app-intents",
      },
      rec.dispatch,
      rec.warn,
    );
    expect(handled).toBe(true);
    expect(rec.sends).toEqual([
      { text: "hello eliza", source: "ios-app-intents" },
    ]);
    expect(rec.warnings).toEqual([]);
  });

  it("trims text and source before dispatching", () => {
    const rec = makeRecorder();
    handleNativeIntentEvent(
      {
        action: "send-message",
        text: "  padded  ",
        source: " ios-app-intents ",
      },
      rec.dispatch,
      rec.warn,
    );
    expect(rec.sends).toEqual([{ text: "padded", source: "ios-app-intents" }]);
  });

  it("ignores non-send actions without dispatching or warning", () => {
    const rec = makeRecorder();
    for (const action of ["navigate", "transcribe", undefined, 42]) {
      const handled = handleNativeIntentEvent(
        { action, text: "hello", source: "ios-app-intents" },
        rec.dispatch,
        rec.warn,
      );
      expect(handled).toBe(false);
    }
    expect(rec.sends).toEqual([]);
    expect(rec.warnings).toEqual([]);
  });

  it("ignores a null event", () => {
    const rec = makeRecorder();
    expect(handleNativeIntentEvent(null, rec.dispatch, rec.warn)).toBe(false);
    expect(rec.sends).toEqual([]);
  });

  it("drops send-message with empty or non-string text, with a warning", () => {
    const rec = makeRecorder();
    for (const text of ["", "   ", 7, undefined]) {
      const handled = handleNativeIntentEvent(
        { action: "send-message", text, source: "ios-app-intents" },
        rec.dispatch,
        rec.warn,
      );
      expect(handled).toBe(false);
    }
    expect(rec.sends).toEqual([]);
    expect(rec.warnings).toHaveLength(4);
  });

  it("drops send-message missing its provenance source instead of fabricating one", () => {
    const rec = makeRecorder();
    const handled = handleNativeIntentEvent(
      { action: "send-message", text: "hello" },
      rec.dispatch,
      rec.warn,
    );
    expect(handled).toBe(false);
    expect(rec.sends).toEqual([]);
    expect(rec.warnings).toHaveLength(1);
    expect(rec.warnings[0]).toContain("source missing");
  });
});

describe("initializeIosIntentSendBridge", () => {
  beforeEach(() => {
    __resetIosIntentSendBridgeForTests();
  });

  it("registers the nativeIntent listener on native iOS and forwards sends", async () => {
    const rec = makeRecorder();
    const { plugin, calls, emit, handle } = makePlugin();
    const result = await initializeIosIntentSendBridge({
      isNativeIos: () => true,
      getPlugin: () => plugin,
      dispatch: rec.dispatch,
      warn: rec.warn,
    });

    expect(result).toBe(handle);
    expect(calls).toEqual([{ eventName: "nativeIntent" }]);

    emit({
      action: "send-message",
      text: "from siri",
      source: "ios-app-intents",
    });
    expect(rec.sends).toEqual([
      { text: "from siri", source: "ios-app-intents" },
    ]);

    emit({ action: "navigate", text: "ignored", source: "ios-app-intents" });
    expect(rec.sends).toHaveLength(1);
  });

  it("is a no-op off native iOS", async () => {
    const rec = makeRecorder();
    const { plugin, calls } = makePlugin();
    const result = await initializeIosIntentSendBridge({
      isNativeIos: () => false,
      getPlugin: () => plugin,
      dispatch: rec.dispatch,
      warn: rec.warn,
    });
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });

  it("degrades with a warning when the plugin lacks the event surface", async () => {
    const rec = makeRecorder();
    const result = await initializeIosIntentSendBridge({
      isNativeIos: () => true,
      getPlugin: () => ({}),
      dispatch: rec.dispatch,
      warn: rec.warn,
    });
    expect(result).toBeNull();
    expect(rec.warnings).toHaveLength(1);
    expect(rec.warnings[0]).toContain("no addListener");
  });

  it("registers at most once across repeated initialization", async () => {
    const rec = makeRecorder();
    const { plugin, calls } = makePlugin();
    const deps = {
      isNativeIos: () => true,
      getPlugin: () => plugin,
      dispatch: rec.dispatch,
      warn: rec.warn,
    };
    const first = initializeIosIntentSendBridge(deps);
    const second = initializeIosIntentSendBridge(deps);
    expect(second).toBe(first);
    await first;
    expect(calls).toHaveLength(1);
  });

  it("resolves null and warns when listener registration rejects", async () => {
    const rec = makeRecorder();
    const plugin: ElizaIntentEventsPluginLike = {
      addListener: () => Promise.reject(new Error("bridge down")),
    };
    const result = await initializeIosIntentSendBridge({
      isNativeIos: () => true,
      getPlugin: () => plugin,
      dispatch: rec.dispatch,
      warn: rec.warn,
    });
    expect(result).toBeNull();
    expect(rec.warnings).toHaveLength(1);
    expect(rec.warnings[0]).toContain("bridge down");
  });
});
