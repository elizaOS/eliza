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

export function installAndroidShim(
  options: {
    /** Milliseconds before a bridge request is rejected. Default 30s. */
    requestTimeoutMs?: number;
  } = {},
): PluginHostShim {
  if (installedAndroidShim) return installedAndroidShim;

  const bridge = window.ElizaosAndroidBridge;
  if (!bridge) {
    throw new Error(
      "installAndroidShim(): window.ElizaosAndroidBridge missing — " +
        "is the WebView configured with addJavascriptInterface(ElizaosAndroidBridge, 'ElizaosAndroidBridge')?",
    );
  }

  const subscribers = new Map<string, Set<(data: JsonValue) => void>>();
  const requestTimeoutMs = Math.max(0, options.requestTimeoutMs ?? 30_000);
  const pending = new Map<
    number,
    {
      reject: (e: Error) => void;
      resolve: (v: JsonValue) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
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
      clearTimeout(slot.timeout);
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
      const safeRelativePath = normalizeRelativePath(relativePath);
      return new URL(
        `https://appassets.androidplatform.net/plugins/${encodeURIComponent(
          pluginName,
        )}/${safeRelativePath}`,
      );
    },
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Android bridge request timed out: ${method}`));
        }, requestTimeoutMs);
        pending.set(id, {
          reject,
          resolve: (v) => resolve(v as never),
          timeout,
        });
        try {
          bridge.postMessage(
            JSON.stringify({ kind: "request", id, method, params }),
          );
        } catch (cause) {
          pending.delete(id);
          clearTimeout(timeout);
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
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
  installedAndroidShim = shim;
  installedAndroidShimCleanup = () => {
    for (const slot of pending.values()) {
      clearTimeout(slot.timeout);
    }
    pending.clear();
  };
  return shim;
}

let installedAndroidShim: PluginHostShim | null = null;
let installedAndroidShimCleanup: (() => void) | null = null;

export function resetAndroidShimForTests(): void {
  installedAndroidShimCleanup?.();
  installedAndroidShimCleanup = null;
  installedAndroidShim = null;
  if (typeof window !== "undefined") {
    delete window.__elizaosAndroidDeliver;
  }
}

function normalizeRelativePath(relativePath: string): string {
  const raw = relativePath.replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`Invalid view asset path: ${relativePath || "<empty>"}`);
  }
  const normalized = raw
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment === "." || segment === "..") {
        throw new Error(`Invalid view asset path: ${relativePath}`);
      }
      return encodeURIComponent(segment);
    })
    .join("/");
  if (!normalized) {
    throw new Error(`Invalid view asset path: ${relativePath || "<empty>"}`);
  }
  return normalized;
}

function isResponse(
  data: unknown,
): data is { id: number; ok: boolean; payload?: JsonValue; error?: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "response" &&
    typeof (data as { id?: unknown }).id === "number" &&
    Number.isFinite((data as { id?: unknown }).id) &&
    typeof (data as { ok?: unknown }).ok === "boolean" &&
    ((data as { error?: unknown }).error === undefined ||
      typeof (data as { error?: unknown }).error === "string")
  );
}

function isEvent(data: unknown): data is { event: string; data: JsonValue } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "event" &&
    typeof (data as { event?: unknown }).event === "string" &&
    Object.hasOwn(data, "data")
  );
}
