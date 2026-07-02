/**
 * DOM renderer for the GUI and XR modalities.
 *
 * GUI and XR share one React tree — the only difference is the cell sizing and
 * touch-target scale the primitives read from {@link useSpatialContext}. So the
 * "renderer" for these two modalities is just a context provider: the spatial
 * primitives render their own DOM. This is intentional — it keeps GUI/XR in
 * exact structural parity with each other and with the TUI IR.
 */

import { type ReactNode, useMemo } from "react";
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

export interface SpatialSurfaceProps {
  /** Presentation modality. Omit to auto-detect (`xr` inside a headset host, else `gui`). */
  modality?: SpatialModality;
  /** Receives primitive actions (button presses, field changes). */
  onAction?: (action: SpatialAction) => void;
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
          // Clear the fixed shell back button (top-left, z-60) so it never
          // occludes a spatial view's first row (e.g. filter chips). The shell
          // wrappers that render ShellBackButton set --shell-backnav-clearance;
          // everywhere else (chat overlay, XR, TUI, stories) it is unset → 0px.
          // See #11144.
          paddingTop: "var(--shell-backnav-clearance, 0px)",
        }}
      >
        {children}
      </div>
    </SpatialContextProvider>
  );
}
