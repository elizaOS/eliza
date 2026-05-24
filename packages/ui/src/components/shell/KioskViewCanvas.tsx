import * as React from "react";

import { cn } from "../../lib/utils";
import type { KioskViewSurface } from "./useKioskViewSurfaces";

/**
 * Renders a single dynamic-view surface as an in-canvas iframe. The view's
 * entrypoint is always a local URL (the Electrobun KioskCanvas only mounts
 * `file://` / loopback entrypoints), so the iframe stays inside the kiosk.
 */
function ViewFrame({
  surface,
  className,
  style,
}: {
  surface: KioskViewSurface;
  className?: string;
  style?: React.CSSProperties;
}): React.JSX.Element {
  return (
    <iframe
      key={surface.windowId}
      title={surface.title}
      src={surface.url}
      // Local agent-authored views: allow scripts + same-origin so they can
      // talk to the loopback agent, but keep top-navigation locked so a view
      // can never replace the kiosk shell itself.
      sandbox="allow-scripts allow-same-origin allow-forms"
      className={cn("h-full w-full border-0 bg-bg", className)}
      style={style}
    />
  );
}

/**
 * Draggable in-canvas window for `floating`-placement views. Under kiosk mode
 * there is exactly one OS toplevel, so a "floating" view is a movable panel
 * positioned within the canvas — not a separate native window.
 */
function FloatingViewWindow({
  surface,
}: {
  surface: KioskViewSurface;
}): React.JSX.Element {
  const [position, setPosition] = React.useState({ x: 80, y: 64 });
  const dragState = React.useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragState.current = {
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [position.x, position.y],
  );

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const origin = dragState.current;
      if (!origin) return;
      setPosition({ x: e.clientX - origin.x, y: e.clientY - origin.y });
    },
    [],
  );

  const onPointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragState.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
    [],
  );

  return (
    <div
      className="absolute flex flex-col overflow-hidden rounded-xl border border-border/50 bg-card shadow-2xl"
      style={{
        left: position.x,
        top: position.y,
        width: surface.width,
        height: surface.height,
      }}
    >
      <div
        className="flex h-8 shrink-0 cursor-grab items-center px-3 text-xs font-medium text-txt active:cursor-grabbing select-none border-b border-border/40 bg-card/80"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {surface.title}
      </div>
      <div className="min-h-0 flex-1">
        <ViewFrame surface={surface} />
      </div>
    </div>
  );
}

/**
 * The kiosk view-manager canvas. Mounts agent-spawned dynamic-view sessions as
 * in-window surfaces (positioned iframes) on the single fullscreen kiosk
 * surface. Full-bleed placements (`canvas`/`panel`/`chat-inline`) stack to fill
 * the canvas with the most-recent view on top; `floating` placements render as
 * draggable in-canvas windows above them.
 */
export function KioskViewCanvas({
  surfaces,
}: {
  surfaces: KioskViewSurface[];
}): React.JSX.Element {
  const fullBleed = surfaces.filter((s) => !s.alwaysOnTop);
  const floating = surfaces.filter((s) => s.alwaysOnTop);

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      {fullBleed.length === 0 && floating.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center">
          <p className="text-sm text-muted">
            Ask Eliza below to open something.
          </p>
        </div>
      ) : null}

      {fullBleed.map((surface, index) => (
        <div
          key={surface.windowId}
          className="absolute inset-0"
          // Stack full-bleed surfaces so the most recently opened view is on
          // top; older surfaces stay mounted underneath (state preserved).
          style={{ zIndex: index + 1 }}
        >
          <ViewFrame surface={surface} />
        </div>
      ))}

      {floating.map((surface) => (
        <FloatingViewWindow key={surface.windowId} surface={surface} />
      ))}
    </div>
  );
}
