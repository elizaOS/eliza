/**
 * Renders a `sandboxed-iframe` isolation-level view (#14180): an untrusted or
 * third-party web view embedded in a real `<iframe sandbox>` instead of the host
 * React realm. `DynamicViewLoader` delegates here when a view's resolved manifest
 * declares `isolation: "sandboxed-iframe"`, so the framed document runs on an
 * opaque origin (the sandbox grants `allow-scripts` but never `allow-same-origin`
 * — see `sandbox-policy.ts`) with no ambient reach into the shell's DOM, storage,
 * cookies, or navigation.
 *
 * The one channel between the frame and the shell is `postMessage`, gated by the
 * capability broker (`sandboxed-view-broker.ts`): this component installs the
 * parent-side listener, binds it to the view's live `navigate`/`storage`
 * facilities, and only accepts messages from THIS frame's `contentWindow`
 * (identity-bound, since an opaque-origin frame reports origin `"null"`). A
 * request for a capability the manifest does not grant is answered with a typed
 * denial and never touches the shell — an ungranted `navigate` changes no route,
 * an ungranted `storage` writes no key. `storage` is confined to a per-view
 * namespace so even a granted view can only ever read/write its own keys, never a
 * shell key.
 */

import {
  type ResolvedSurfaceManifest,
  resolveSurfaceManifest,
  type SurfaceManifest,
} from "@elizaos/core";
import { logger } from "@elizaos/logger";
import { dispatchNavigateViewEvent } from "@elizaos/shared/events";
import { useEffect, useMemo, useRef } from "react";
import { shellLocalStorage } from "../../surface-realm-channel";
import { resolveSandboxTokens } from "./sandbox-policy";
import {
  brokerSandboxedViewRequest,
  parseSandboxedViewRequest,
  type SandboxHostFacilities,
} from "./sandboxed-view-broker";

/** localStorage prefix that confines a framed view to its own key namespace. */
export const SANDBOX_STORAGE_PREFIX = "eliza:sbxview:" as const;

/** Build the storage key without letting view IDs and frame keys collapse into the same path. */
export function sandboxStorageKey(viewId: string, key: string): string {
  return `${SANDBOX_STORAGE_PREFIX}${encodeURIComponent(viewId)}:${encodeURIComponent(key)}`;
}

/**
 * The concrete host facilities the broker calls for a view. Split out (and
 * exported) so tests exercise the real navigate/storage behaviour directly, and
 * so the frame's listener binds one stable object per view.
 */
export function createSandboxHostFacilities(
  viewId: string,
): SandboxHostFacilities {
  return {
    async navigate(payload: unknown): Promise<unknown> {
      const target = readNavigatePayload(payload);
      dispatchNavigateViewEvent({
        viewId: target.viewId,
        subview: target.subview,
        action: target.action,
      });
      return { navigated: true, viewId: target.viewId };
    },
    async storage(payload: unknown): Promise<unknown> {
      const request = readStoragePayload(payload);
      const namespaced = sandboxStorageKey(viewId, request.key);
      if (request.op === "get") {
        return { value: window.localStorage.getItem(namespaced) };
      }
      if (request.op === "set") {
        shellLocalStorage.setItem(namespaced, request.value);
        return { ok: true };
      }
      shellLocalStorage.removeItem(namespaced);
      return { ok: true };
    },
  };
}

interface NavigateTarget {
  viewId: string;
  subview?: string;
  action?: string;
}

function readNavigatePayload(payload: unknown): NavigateTarget {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("navigate requires a { viewId } payload");
  }
  const record = payload as Record<string, unknown>;
  const viewId = record.viewId;
  if (typeof viewId !== "string" || viewId.length === 0) {
    throw new Error("navigate requires a non-empty string `viewId`");
  }
  return {
    viewId,
    subview: typeof record.subview === "string" ? record.subview : undefined,
    action: typeof record.action === "string" ? record.action : undefined,
  };
}

type StorageRequest =
  | { op: "get"; key: string }
  | { op: "set"; key: string; value: string }
  | { op: "remove"; key: string };

function readStoragePayload(payload: unknown): StorageRequest {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("storage requires a { op, key } payload");
  }
  const record = payload as Record<string, unknown>;
  const key = record.key;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("storage requires a non-empty string `key`");
  }
  const op = record.op;
  if (op === "get") return { op, key };
  if (op === "remove") return { op, key };
  if (op === "set") {
    if (typeof record.value !== "string") {
      throw new Error("storage set requires a string `value`");
    }
    return { op, key, value: record.value };
  }
  throw new Error(`storage: unknown op "${String(op)}"`);
}

interface SandboxedViewFrameProps {
  viewId: string;
  /** The view's declared manifest; resolved to gate the postMessage broker. */
  surface?: SurfaceManifest;
  /**
   * Cross-origin (or opaque-served) document URL for the framed view. Exactly
   * one of `src` / `srcDoc` is used; `src` is the path for served plugin views.
   */
  src?: string;
  /**
   * Inline HTML document for a first-party framed view (the sandbox-probe
   * diagnostics view uses this). Rendered on an opaque origin like any other
   * sandboxed frame — the inline source does not grant it host access.
   */
  srcDoc?: string;
  /** Extra sandbox tokens to union with the safe default; validated (never defeats the sandbox). */
  sandboxExtra?: readonly string[];
  title: string;
}

/**
 * Mount a framed view and broker its postMessage requests. The listener binds to
 * the specific frame `contentWindow` so a message from any other window (or the
 * host itself) is ignored, and it resolves the manifest once so the grant check
 * reads a stable {@link ResolvedSurfaceManifest}.
 */
export function SandboxedViewFrame({
  viewId,
  surface,
  src,
  srcDoc,
  sandboxExtra,
  title,
}: SandboxedViewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const resolvedManifest: ResolvedSurfaceManifest = useMemo(
    () => resolveSurfaceManifest({ surface }),
    [surface],
  );
  // Enforced here too (not only in the attribute) so a bad `sandboxExtra` fails
  // the render loudly rather than emitting a decorative sandbox.
  const sandbox = useMemo(
    () => resolveSandboxTokens(sandboxExtra),
    [sandboxExtra],
  );
  const facilities = useMemo(
    () => createSandboxHostFacilities(viewId),
    [viewId],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow;
      // Identity gate: only this frame may drive its own broker. An opaque-origin
      // sandbox reports origin "null", so binding to the window object — not an
      // origin string — is the correct, spoof-proof check.
      if (!frameWindow || event.source !== frameWindow) return;
      const request = parseSandboxedViewRequest(event.data);
      if (!request) return;
      void brokerSandboxedViewRequest(
        viewId,
        resolvedManifest,
        request,
        facilities,
      ).then((response) => {
        if (!response.ok) {
          logger.warn(
            `[SandboxedViewFrame] denied "${request.capability}" for view "${viewId}": ${response.error}`,
          );
        }
        // Opaque-origin frames cannot be targeted by origin, so "*" is required;
        // the payload is a capability result, not a secret.
        frameWindow.postMessage(response, "*");
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [viewId, resolvedManifest, facilities]);

  return (
    <iframe
      ref={frameRef}
      data-testid={`sandboxed-view-frame-${viewId}`}
      title={title}
      sandbox={sandbox}
      src={src}
      srcDoc={srcDoc}
      className="h-full w-full border-0 bg-bg"
    />
  );
}
