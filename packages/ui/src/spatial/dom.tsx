/**
 * DOM renderer for the GUI and XR modalities.
 *
 * GUI and XR share one React tree — the only difference is the cell sizing and
 * touch-target scale the primitives read from {@link useSpatialContext}. So the
 * "renderer" for these two modalities is just a context provider: the spatial
 * primitives render their own DOM. This is intentional — it keeps GUI/XR in
 * exact structural parity with each other and with the TUI IR.
 */

import type { ReactNode } from "react";
import { type SpatialAction, SpatialContextProvider } from "./context.ts";
import type { SpatialModality } from "./ir.ts";

/**
 * Detect the active DOM modality (`gui` vs `xr`).
 *
 * The XR view-host (`plugin-facewear` / `plugin-xr`) sets `window.__elizaXRContext`
 * when a view runs inside a headset — the same signal `getActiveViewModality()`
 * uses. Mirrored here (without importing `platform/` so the spatial barrel stays
 * Capacitor-free) so `<SpatialSurface>` picks the surface automatically.
 */
export function detectDomModality(): SpatialModality {
  if (
    typeof window !== "undefined" &&
    (window as unknown as Record<string, unknown>).__elizaXRContext
  ) {
    return "xr";
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
  return (
    <SpatialContextProvider value={{ modality: resolved, dispatch: onAction }}>
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
        }}
      >
        {children}
      </div>
    </SpatialContextProvider>
  );
}
