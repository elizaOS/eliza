/**
 * DOM renderer for the GUI and XR modalities.
 *
 * GUI and XR share one React tree — the only difference is the cell sizing and
 * touch-target scale the primitives read from {@link useSpatialContext}. So the
 * "renderer" for these two modalities is just a context provider: the spatial
 * primitives render their own DOM. This is intentional — it keeps GUI/XR in
 * exact structural parity with each other and with the TUI IR.
 */

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type SpatialAction, SpatialContextProvider } from "./context.ts";
import type { SpatialModality } from "./ir.ts";

declare global {
  interface Window {
    /** Set by the XR view-host (plugin-facewear / plugin-xr) inside a headset. */
    __elizaXRContext?: unknown;
    /**
     * The single shell-level modality owner (#9946). A shell sets this once
     * (`setShellModality`) to declare which surface it presents; every leaf's
     * `detectDomModality()` then reads it instead of each re-guessing, so the
     * GUI/TUI/XR contract has one authoritative source. A headset (`__elizaXRContext`)
     * still wins so the XR host is never overridden.
     */
    __elizaShellModality?: SpatialModality;
  }
}

function isSpatialModality(value: unknown): value is SpatialModality {
  return value === "gui" || value === "tui" || value === "xr";
}

/**
 * Declare the shell-level presentation modality (#9946). Call once from the
 * shell that owns the surface (e.g. `packages/app` mounts the GUI shell).
 * Returns a disposer that restores the previous value.
 */
export function setShellModality(modality: SpatialModality): () => void {
  if (typeof window === "undefined") return () => {};
  const previous = window.__elizaShellModality;
  window.__elizaShellModality = modality;
  return () => {
    window.__elizaShellModality = previous;
  };
}

/**
 * Detect the active DOM modality (`gui` / `tui` / `xr`).
 *
 * Order of authority: a headset (`__elizaXRContext`, set by plugin-facewear /
 * plugin-xr) always wins; otherwise the shell-level owner (`__elizaShellModality`)
 * decides; otherwise default to `gui`. This keeps the spatial barrel Capacitor-
 * free while giving the modality contract a single shell-level source.
 */
export function detectDomModality(): SpatialModality {
  if (typeof window === "undefined") return "gui";
  if (window.__elizaXRContext) {
    return "xr";
  }
  if (isSpatialModality(window.__elizaShellModality)) {
    return window.__elizaShellModality;
  }
  return "gui";
}

const CONTINUOUS_CHAT_SIDE_CLEARANCE_VAR =
  "--eliza-continuous-chat-side-clearance";
const CONTINUOUS_CHAT_CLEARANCE_VAR = "--eliza-continuous-chat-clearance";
const COMPACT_CHAT_MOBILE_QUERY = "(max-width: 767px)";

function readRootPxVarActive(name: string): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  const root = document.documentElement;
  const raw =
    getComputedStyle(root).getPropertyValue(name) ||
    root.style.getPropertyValue(name);
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) && px > 0.5;
}

function useRootPxVarActive(name: string): boolean {
  const [active, setActive] = useState(() => readRootPxVarActive(name));

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }
    const publish = () => setActive(readRootPxVarActive(name));
    publish();
    const observer = new MutationObserver(publish);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    window.addEventListener("resize", publish);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
    };
  }, [name]);

  return active;
}

/**
 * True while the app shell's continuous chat composer publishes an inline-end
 * clearance. GUI wrappers can use this to switch dense spatial views into a
 * short-landscape layout; terminal/SSR callers get `false`.
 */
export function useContinuousChatSideClearanceActive(): boolean {
  return useRootPxVarActive(CONTINUOUS_CHAT_SIDE_CLEARANCE_VAR);
}

/**
 * True while the app shell's continuous chat composer publishes any resting
 * bottom clearance. This tracks the floating composer footprint without
 * assuming the view should collapse its content.
 */
export function useContinuousChatClearanceActive(): boolean {
  return useRootPxVarActive(CONTINUOUS_CHAT_CLEARANCE_VAR);
}

function readCompactChatViewport(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") {
    return window.matchMedia(COMPACT_CHAT_MOBILE_QUERY).matches;
  }
  return window.innerWidth <= 767;
}

/**
 * True when shell-hosted GUI content should use its compact chat-aware layout:
 * side clearance in short landscape, or bottom composer clearance on mobile
 * width. Desktop keeps the fuller spatial layout even though it reserves bottom
 * padding for the ambient composer.
 */
export function useContinuousChatCompactClearanceActive(): boolean {
  const sideClearance = useContinuousChatSideClearanceActive();
  const bottomClearance = useContinuousChatClearanceActive();
  const [compactViewport, setCompactViewport] = useState(
    readCompactChatViewport,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const publish = () => setCompactViewport(readCompactChatViewport());
    publish();
    window.addEventListener("resize", publish);
    return () => window.removeEventListener("resize", publish);
  }, []);

  return sideClearance || (bottomClearance && compactViewport);
}

export interface SpatialSurfaceProps {
  /** Presentation modality. Omit to auto-detect (`xr` inside a headset host, else `gui`). */
  modality?: SpatialModality;
  /** Receives primitive actions (button presses, field changes). */
  onAction?: (action: SpatialAction) => void;
  /**
   * Reserve the app shell's floating chat-composer clearance. Shell-hosted
   * plugin views opt in; standalone spatial renders keep their exact footprint.
   */
  reserveChatClearance?: boolean;
  children: ReactNode;
}

/**
 * Host for a spatial view on a DOM surface (GUI or XR).
 *
 * Omit `modality` and it auto-detects the headset — so a plugin mounts the same
 * view with `<SpatialSurface>` on both surfaces with zero modality knowledge.
 *
 * ```tsx
 * <SpatialSurface>
 *   <ProfileView profile={p} />
 * </SpatialSurface>
 * ```
 */
export function SpatialSurface({
  modality,
  onAction,
  reserveChatClearance = false,
  children,
}: SpatialSurfaceProps) {
  const resolved = modality ?? detectDomModality();
  const value = useMemo(
    () => ({ modality: resolved, dispatch: onAction }),
    [resolved, onAction],
  );
  return (
    <SpatialContextProvider value={value}>
      <div
        data-spatial-surface={resolved}
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          minHeight: 0,
          minWidth: 0,
          boxSizing: "border-box",
          overflowX: reserveChatClearance ? "hidden" : undefined,
          overflowY: reserveChatClearance ? "auto" : undefined,
          overscrollBehavior: reserveChatClearance ? "contain" : undefined,
          paddingBottom: reserveChatClearance
            ? "var(--eliza-continuous-chat-clearance, 5.25rem)"
            : undefined,
          paddingInlineEnd: reserveChatClearance
            ? "var(--eliza-continuous-chat-side-clearance, 0px)"
            : undefined,
          scrollPaddingBottom: reserveChatClearance
            ? "var(--eliza-continuous-chat-clearance, 5.25rem)"
            : undefined,
          scrollPaddingInlineEnd: reserveChatClearance
            ? "var(--eliza-continuous-chat-side-clearance, 0px)"
            : undefined,
        }}
      >
        {children}
      </div>
    </SpatialContextProvider>
  );
}
