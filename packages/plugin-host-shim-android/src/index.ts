/**
 * Android implementation of {@link PluginHostShim}. View bundles load
 * inside a `WebView` whose `addJavascriptInterface` exposes
 * `globalThis.ElizaosAndroidBridge` (a `@JavascriptInterface`-annotated
 * Kotlin object). The Kotlin side forwards messages into the in-process
 * Bun runtime and calls `webView.evaluateJavascript(...)` to push
 * responses back as JSON via `globalThis.__elizaosAndroidDeliver(...)`.
 */

import {
  installHostShim,
  type PluginHostShim,
} from "@elizaos/plugin-host-shim";
import type { JsonValue } from "@elizaos/plugin-remote-manifest";

interface AndroidBridge {
  postMessage(message: string): void;
}

declare global {
  interface Window {
    ElizaosAndroidBridge?: AndroidBridge;
    __elizaosAndroidDeliver?: (json: string) => void;
  }
}

export function installAndroidShim(): PluginHostShim {
  const bridge = window.ElizaosAndroidBridge;
  if (!bridge) {
    throw new Error(
      "installAndroidShim(): window.ElizaosAndroidBridge missing — " +
        "is the WebView configured with addJavascriptInterface(ElizaosAndroidBridge, 'ElizaosAndroidBridge')?",
    );
  }

  const subscribers = new Map<string, Set<(data: JsonValue) => void>>();
  const pending = new Map<
    number,
    { resolve: (v: JsonValue) => void; reject: (e: Error) => void }
  >();
  let nextId = 0;

  window.__elizaosAndroidDeliver = (json: string) => {
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      return;
    }
    if (isResponse(data)) {
      const slot = pending.get(data.id);
      if (!slot) return;
      pending.delete(data.id);
      if (data.ok) {
        slot.resolve((data.payload ?? null) as JsonValue);
      } else {
        slot.reject(new Error(data.error ?? "Android bridge error"));
      }
      return;
    }
    if (isEvent(data)) {
      const set = subscribers.get(data.event);
      if (!set) return;
      for (const fn of set) fn(data.data);
    }
  };

  const shim: PluginHostShim = {
    resolveViewUrl(pluginName, relativePath) {
      // Android uses WebViewAssetLoader for plugin assets:
      // https://appassets.androidplatform.net/plugins/<name>/<path>
      return new URL(
        `https://appassets.androidplatform.net/plugins/${encodeURIComponent(
          pluginName,
        )}/${relativePath}`,
      );
    },
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, {
          resolve: (v) => resolve(v as never),
          reject,
        });
        bridge.postMessage(
          JSON.stringify({ kind: "request", id, method, params }),
        );
      });
    },
    on(event, handler) {
      let set = subscribers.get(event);
      if (!set) {
        set = new Set();
        subscribers.set(event, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
  };

  installHostShim(shim);
  return shim;
}

function isResponse(
  data: unknown,
): data is { id: number; ok: boolean; payload?: JsonValue; error?: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "response" &&
    typeof (data as { id?: unknown }).id === "number"
  );
}
function isEvent(data: unknown): data is { event: string; data: JsonValue } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "event" &&
    typeof (data as { event?: unknown }).event === "string"
  );
}
