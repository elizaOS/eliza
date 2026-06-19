/**
 * Web / XR iframe implementation of {@link PluginHostShim}. The view
 * bundle loads inside an iframe whose parent is the elizaOS dashboard
 * (or the XR view-host page from `plugins/plugin-xr`). Requests are
 * delivered via `parent.postMessage` and the parent forwards them to
 * the agent's HTTP endpoint at `/api/plugins/remote/:name/invoke`.
 *
 * The wire envelope between iframe and parent is a tiny JSON object:
 *
 *     { kind: "elizaos.shim.request", id, method, params }
 *     { kind: "elizaos.shim.response", id, ok, payload?, error? }
 *     { kind: "elizaos.shim.event", event, data }
 */

import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import { installHostShim, type PluginHostShim } from "./index";

interface ParentRequest {
  kind: "elizaos.shim.request";
  id: number;
  method: string;
  params: JsonValue;
}
interface ParentResponse {
  kind: "elizaos.shim.response";
  id: number;
  ok: boolean;
  payload?: JsonValue;
  error?: string;
}
interface ParentEvent {
  kind: "elizaos.shim.event";
  event: string;
  data: JsonValue;
}

/**
 * Build and install the web shim. Idempotent — calling twice is a
 * single-install operation. Returns the installed shim for callers that want to keep a
 * reference (most just use {@link getHostShim}).
 */
export function installWebShim(
  options: {
    /** Origin to send postMessage to. Defaults to "*"; production agents should pin this. */
    parentOrigin?: string;
    /** Milliseconds before a parent request is rejected. Default 30s. */
    requestTimeoutMs?: number;
    /** Base path the agent serves view bundles from. Default `/api/views`. */
    viewsBasePath?: string;
  } = {},
): PluginHostShim {
  if (installedWebShim) return installedWebShim;

  const parentOrigin = options.parentOrigin ?? "*";
  const requestTimeoutMs = Math.max(0, options.requestTimeoutMs ?? 30_000);
  const viewsBasePath = options.viewsBasePath ?? "/api/views";

  const subscribers = new Map<string, Set<(data: JsonValue) => void>>();
  const pending = new Map<
    number,
    {
      reject: (e: Error) => void;
      resolve: (v: JsonValue) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  let nextRequestId = 0;

  const onMessage = (event: MessageEvent) => {
    if (parentOrigin !== "*" && event.origin !== parentOrigin) return;
    if (event.source !== window.parent) return;
    const message = event.data;
    if (isParentResponse(message)) {
      const slot = pending.get(message.id);
      if (!slot) return;
      pending.delete(message.id);
      clearTimeout(slot.timeout);
      if (message.ok) {
        slot.resolve((message.payload ?? null) as JsonValue);
      } else {
        slot.reject(new Error(message.error ?? "Unknown shim error"));
      }
      return;
    }
    if (isParentEvent(message)) {
      const set = subscribers.get(message.event);
      if (!set) return;
      for (const handler of set) handler(message.data);
    }
  };
  window.addEventListener("message", onMessage);

  const shim: PluginHostShim = {
    resolveViewUrl(pluginName, relativePath) {
      const safeRelativePath = normalizeRelativePath(relativePath);
      return new URL(
        `${viewsBasePath}/${encodeURIComponent(pluginName)}/${safeRelativePath}`,
        window.location.href,
      );
    },
    request(method, params) {
      const id = ++nextRequestId;
      const envelope: ParentRequest = {
        kind: "elizaos.shim.request",
        id,
        method,
        params,
      };
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Host shim request timed out: ${method}`));
        }, requestTimeoutMs);
        pending.set(id, {
          reject,
          resolve: (v) => resolve(v as never),
          timeout,
        });
        try {
          window.parent.postMessage(envelope, parentOrigin);
        } catch (error) {
          pending.delete(id);
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
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
  installedWebShim = shim;
  installedWebShimCleanup = () => {
    window.removeEventListener("message", onMessage);
    for (const slot of pending.values()) {
      clearTimeout(slot.timeout);
    }
    pending.clear();
  };
  return shim;
}

let installedWebShim: PluginHostShim | null = null;
let installedWebShimCleanup: (() => void) | null = null;

export function resetWebShimForTests(): void {
  installedWebShimCleanup?.();
  installedWebShimCleanup = null;
  installedWebShim = null;
}

function normalizeRelativePath(relativePath: string): string {
  const raw = relativePath.replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`Invalid view asset path: ${relativePath || "<empty>"}`);
  }
  const normalized = raw
    .split("/")
    .map((segment) => {
      if (segment === "" || segment === "." || segment === "..") {
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

function isParentResponse(message: unknown): message is ParentResponse {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as Partial<ParentResponse>;
  return (
    candidate.kind === "elizaos.shim.response" &&
    typeof candidate.id === "number" &&
    Number.isFinite(candidate.id) &&
    typeof candidate.ok === "boolean" &&
    (candidate.error === undefined || typeof candidate.error === "string")
  );
}

function isParentEvent(message: unknown): message is ParentEvent {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as Partial<ParentEvent>;
  return (
    candidate.kind === "elizaos.shim.event" &&
    typeof candidate.event === "string" &&
    Object.hasOwn(candidate, "data")
  );
}
