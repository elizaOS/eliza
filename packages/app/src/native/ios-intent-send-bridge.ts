/**
 * Renderer half of the iOS native auto-send channel. `SendElizaMessageIntent`
 * runs in-process (openAppWhenRun) and posts NotificationCenter → the custom
 * `ElizaIntent` Capacitor plugin (ElizaIntentPlugin.swift), which emits
 * `nativeIntent` events into this WebView. This module attaches that listener
 * on native iOS and forwards `send-message` payloads into the shell's
 * CHAT_SEND_EVENT via `dispatchChatSend`, which ChatOverlay consumes as an
 * actual send. The `elizaos://` URL/hash spine stays prefill-only by design —
 * URLs are forgeable by any app — so this plugin event, reachable only from
 * native code, is the one channel allowed to auto-send.
 *
 * Cold start is handled natively: the plugin emits with `retainUntilConsumed`,
 * so an intent fired before this listener attaches is delivered on attach.
 */

import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { getNativePlugin } from "@elizaos/ui/bridge";
import { type ChatSendEventDetail, dispatchChatSend } from "@elizaos/ui/events";
import { APP_LOG_PREFIX } from "../app-config";

/** Payload shape emitted by the native `nativeIntent` event (untrusted until validated). */
export interface NativeIntentEvent {
  action?: unknown;
  text?: unknown;
  source?: unknown;
}

export interface ElizaIntentEventsPluginLike extends Record<string, unknown> {
  addListener?: (
    eventName: "nativeIntent",
    listenerFunc: (event: NativeIntentEvent) => void,
  ) => Promise<PluginListenerHandle>;
}

export interface IosIntentSendBridgeDeps {
  isNativeIos: () => boolean;
  getPlugin: () => ElizaIntentEventsPluginLike;
  dispatch: (detail: ChatSendEventDetail) => void;
  warn: (message: string) => void;
}

const defaultDeps: IosIntentSendBridgeDeps = {
  isNativeIos: () =>
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios",
  getPlugin: () => getNativePlugin<ElizaIntentEventsPluginLike>("ElizaIntent"),
  dispatch: dispatchChatSend,
  warn: (message) => console.warn(`${APP_LOG_PREFIX} ${message}`),
};

/**
 * Validate one `nativeIntent` event and forward a well-formed `send-message`
 * into the chat shell. Anything else — other actions (future channel users),
 * empty text, or a payload missing its provenance `source` — is ignored rather
 * than sent: a message with no provenance would be a native-side bug, and this
 * boundary never fabricates a source tag. Returns whether a send was dispatched.
 */
export function handleNativeIntentEvent(
  event: NativeIntentEvent | null | undefined,
  dispatch: (detail: ChatSendEventDetail) => void,
  warn: (message: string) => void,
): boolean {
  if (event?.action !== "send-message") return false;
  const text = typeof event.text === "string" ? event.text.trim() : "";
  const source = typeof event.source === "string" ? event.source.trim() : "";
  if (!text || !source) {
    // error-policy:J3 untrusted-boundary payload — malformed send is dropped
    // with an explicit warning, never dispatched with fabricated fields.
    warn(
      `Ignored malformed nativeIntent send-message event (text ${text ? "present" : "missing"}, source ${source ? "present" : "missing"})`,
    );
    return false;
  }
  dispatch({ text, source });
  return true;
}

let listenerRegistration: Promise<PluginListenerHandle | null> | null = null;

/**
 * Attach the `nativeIntent` listener once per WebView. No-op off native iOS
 * (web, desktop, Android — Android's auto-send channel is its own bridge) and
 * when the plugin is absent (e.g. an outdated native shell hosting a newer
 * renderer bundle).
 */
export function initializeIosIntentSendBridge(
  deps: Partial<IosIntentSendBridgeDeps> = {},
): Promise<PluginListenerHandle | null> {
  const resolved: IosIntentSendBridgeDeps = { ...defaultDeps, ...deps };
  if (listenerRegistration) return listenerRegistration;
  if (!resolved.isNativeIos()) return Promise.resolve(null);

  const plugin = resolved.getPlugin();
  if (typeof plugin.addListener !== "function") {
    // error-policy:J4 optional native module — an older shell without the
    // event surface degrades to the prefill-only deep-link spine.
    resolved.warn(
      "ElizaIntent plugin has no addListener; native auto-send channel unavailable",
    );
    return Promise.resolve(null);
  }

  listenerRegistration = plugin
    .addListener("nativeIntent", (event) => {
      handleNativeIntentEvent(event, resolved.dispatch, resolved.warn);
    })
    .catch((error: unknown) => {
      // error-policy:J4 optional native module — registration failure is
      // logged and the channel stays unavailable; deep links still work.
      resolved.warn(
        `ElizaIntent nativeIntent listener registration failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    });
  return listenerRegistration;
}

/** Test-only: allow re-registration in a fresh test case. */
export function __resetIosIntentSendBridgeForTests(): void {
  listenerRegistration = null;
}
