/**
 * iOS implementation of {@link PluginHostShim}. View bundles run inside
 * a `WKWebView` whose `WKUserContentController` exposes the
 * `elizaosBridge` script-message handler. The Swift side forwards
 * messages into the in-process Bun runtime (`plugin-capacitor-bridge`
 * → `bootElizaRuntime()` → `RemotePluginBridge`) and posts responses
 * back via `evaluateJavaScript`.
 *
 * Wire envelope between WKWebView and Swift bridge is the same JSON
 * shape as the Electrobun preload bridge:
 *
 *     { kind: "request",  id, method, params }
 *     { kind: "response", id, ok, payload?, error? }
 *     { kind: "event",    event, data }
 */

import {
  installHostShim,
  type PluginHostShim,
} from "@elizaos/plugin-host-shim";
import type { JsonValue } from "@elizaos/plugin-remote-manifest";

interface IosMessageHandler {
  postMessage(message: unknown): void;
}

interface IosWebkit {
  messageHandlers: {
    elizaosBridge?: IosMessageHandler;
  };
}

declare global {
  interface Window {
    webkit?: IosWebkit;
    /** Set by the Swift bridge before posting an "elizaosBridge" message back. */
    __elizaosIosDeliver?: (data: unknown) => void;
  }
}

export function installIosShim(
  options: {
    /** Milliseconds before a bridge request is rejected. Default 30s. */
    requestTimeoutMs?: number;
  } = {},
): PluginHostShim {
  if (installedIosShim) return installedIosShim;

  const handler = window.webkit?.messageHandlers?.elizaosBridge;
  if (!handler || typeof handler.postMessage !== "function") {
    throw new Error(
      "installIosShim(): window.webkit.messageHandlers.elizaosBridge missing — " +
        "is the WKWebView configured with the elizaosBridge WKScriptMessageHandler?",
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

  // Swift calls window.__elizaosIosDeliver(...) via evaluateJavaScript
  // to push responses + events back into the view.
  window.__elizaosIosDeliver = (data: unknown) => {
    if (isResponse(data)) {
      const slot = pending.get(data.id);
      if (!slot) return;
      pending.delete(data.id);
      clearTimeout(slot.timeout);
      if (data.ok) {
        slot.resolve((data.payload ?? null) as JsonValue);
      } else {
        slot.reject(new Error(data.error ?? "iOS bridge error"));
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
      // iOS host serves plugin assets via a custom URL scheme rooted
      // at the app sandbox: app-resource://plugin/<name>/<path>.
      const safeRelativePath = normalizeRelativePath(relativePath);
      return new URL(
        `app-resource://plugin/${encodeURIComponent(pluginName)}/${safeRelativePath}`,
      );
    },
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`iOS bridge request timed out: ${method}`));
        }, requestTimeoutMs);
        pending.set(id, {
          reject,
          resolve: (v) => resolve(v as never),
          timeout,
        });
        try {
          handler.postMessage({ kind: "request", id, method, params });
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
  installedIosShim = shim;
  installedIosShimCleanup = () => {
    for (const slot of pending.values()) {
      clearTimeout(slot.timeout);
    }
    pending.clear();
  };
  return shim;
}

let installedIosShim: PluginHostShim | null = null;
let installedIosShimCleanup: (() => void) | null = null;

export function resetIosShimForTests(): void {
  installedIosShimCleanup?.();
  installedIosShimCleanup = null;
  installedIosShim = null;
  if (typeof window !== "undefined") {
    delete window.__elizaosIosDeliver;
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
