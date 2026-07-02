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

/** Drag-clamp margins. The clamp keeps the title bar fully on-canvas
 *  vertically and at least WINDOW_GRAB_MARGIN_PX of it visible horizontally,
 *  so a dragged window can always be grabbed again. WINDOW_TITLE_BAR_PX
 *  matches `h-8` on the drag handle below. */
const WINDOW_GRAB_MARGIN_PX = 48;
const WINDOW_TITLE_BAR_PX = 32;

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
  const dragState = React.useRef<{
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);

  /** Keep the title bar reachable: fully on-canvas vertically, and at least
   *  WINDOW_GRAB_MARGIN_PX of it visible horizontally — a window can never be
   *  dragged somewhere it cannot be dragged back from. */
  const clampToCanvas = React.useCallback(
    (handle: HTMLElement, x: number, y: number) => {
      const canvas = handle.parentElement?.parentElement;
      if (!canvas) return { x, y };
      return {
        x: Math.min(
          Math.max(x, WINDOW_GRAB_MARGIN_PX - surface.width),
          Math.max(0, canvas.clientWidth - WINDOW_GRAB_MARGIN_PX),
        ),
        y: Math.min(
          Math.max(y, 0),
          Math.max(0, canvas.clientHeight - WINDOW_TITLE_BAR_PX),
        ),
      };
    },
    [surface.width],
  );

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // One drag at a time: a second touch point must not re-base the origin
      // of the drag already in flight.
      if (dragState.current) return;
      dragState.current = {
        pointerId: e.pointerId,
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Capture is best-effort (detached node / already-released pointer).
      }
    },
    [position.x, position.y],
  );

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const origin = dragState.current;
      if (!origin || origin.pointerId !== e.pointerId) return;
      setPosition(
        clampToCanvas(
          e.currentTarget,
          e.clientX - origin.x,
          e.clientY - origin.y,
        ),
      );
    },
    [clampToCanvas],
  );

  // Shared release path for pointerup AND pointercancel/lostpointercapture:
  // a touch-scroll takeover or OS revocation ends the pointer with a CANCEL,
  // not an up — leaving dragState set made the window ghost-follow the next
  // buttonless hover over the title bar.
  const endDrag = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const origin = dragState.current;
    if (!origin || origin.pointerId !== e.pointerId) return;
    dragState.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // The browser may already have revoked capture.
    }
  }, []);

  return (
    <div
      className="absolute flex flex-col overflow-hidden rounded-sm border border-border/50 bg-card "
      style={{
        left: position.x,
        top: position.y,
        width: surface.width,
        height: surface.height,
      }}
    >
      <div
        className="flex h-8 shrink-0 cursor-grab items-center px-3 text-xs font-medium text-txt active:cursor-grabbing select-none border-b border-border/40 bg-card/80"
        // The handle is a pure drag surface: without `touch-action: none` a
        // touch drag is claimed by the browser as a scroll attempt, which
        // fires pointercancel mid-drag instead of tracking the finger.
        style={{ touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
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
 * surface.
 *
 * Only ONE surface is ever mounted at a time so exactly one view runs (one
 * iframe = one render tree, RAF loop, and WebGL context). The surface registry
 * (`useKioskViewSurfaces`) keeps every mounted/unmounted surface in its list,
 * but this canvas renders only the single active one and leaves the rest fully
 * unmounted so they stop executing.
 *
 * Active surface selection: surfaces arrive in mount order (newest appended
 * last by `useKioskViewSurfaces`), so the last entry is the most recently
 * opened — the one the user is looking at. A `floating` (`alwaysOnTop`) view
 * wins over a full-bleed view when both exist, since the agent opened it to sit
 * on top; otherwise the newest full-bleed view is shown.
 */
export function KioskViewCanvas({
  surfaces,
}: {
  surfaces: KioskViewSurface[];
}): React.JSX.Element {
  // Newest surface is last. A floating view, if any, is the intended
  // foreground; otherwise the newest full-bleed view is the active one.
  const activeSurface = React.useMemo(() => {
    let activeFullBleed: KioskViewSurface | null = null;
    let activeFloating: KioskViewSurface | null = null;
    for (const surface of surfaces) {
      if (surface.alwaysOnTop) {
        activeFloating = surface;
      } else {
        activeFullBleed = surface;
      }
    }
    return activeFloating ?? activeFullBleed;
  }, [surfaces]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      {activeSurface === null ? (
        <div className="flex h-full w-full items-center justify-center">
          <p className="text-sm text-muted">
            Ask Eliza below to open something.
          </p>
        </div>
      ) : activeSurface.alwaysOnTop ? (
        <FloatingViewWindow
          key={activeSurface.windowId}
          surface={activeSurface}
        />
      ) : (
        <div key={activeSurface.windowId} className="absolute inset-0">
          <ViewFrame surface={activeSurface} />
        </div>
      )}
    </div>
  );
}
