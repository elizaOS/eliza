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

export interface SpatialSurfaceProps {
  /** Presentation modality. Defaults to `gui`. Pass `xr` inside a headset host. */
  modality?: SpatialModality;
  /** Receives primitive actions (button presses, field changes). */
  onAction?: (action: SpatialAction) => void;
  children: ReactNode;
}

/**
 * Host for a spatial view on a DOM surface (GUI or XR).
 *
 * ```tsx
 * <SpatialSurface modality="xr">
 *   <ProfileView profile={p} />
 * </SpatialSurface>
 * ```
 */
export function SpatialSurface({
  modality = "gui",
  onAction,
  children,
}: SpatialSurfaceProps) {
  return (
    <SpatialContextProvider value={{ modality, dispatch: onAction }}>
      <div
        data-spatial-surface={modality}
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
