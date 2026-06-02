// Window-manager controls for the odysseus tool views (static/js/windowDrag.js
// + windowResize.js + tileManager.js + modalSnap.js + modalManager.js).
// Turns a centered overlay panel into a draggable + edge/corner-resizable
// floating window whose position/size persist per view, with desktop
// edge-tiling (snap) on title-bar drag.
//
// Usage: const win = useWindowControls("win-compare", { w: 1180, h: 880 });
//   - overlay:  className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
//   - panel:    style={win.panelStyle}
//   - header:   onPointerDown={win.onDragStart}   (drags ignore buttons/inputs)
//   - inside panel: <ResizeHandles controls={win} />
//   - snap preview (rendered by the view, fixed-position so it floats above):
//       {win.snapGhost ? <div className="od-snap-ghost" style={win.snapGhost} /> : null}
// Until the user first drags/resizes, `windowed` is false and the panel keeps
// its default centered CSS — so nothing changes visually until interacted with.
//
// TILING (tileManager.js port): while dragging the title bar, when the pointer
// nears a screen edge we compute a snap target and expose `snapGhost` (a fixed
// CSS rect) so a translucent preview can render. On pointer-up over a zone the
// panel rect snaps to that target; the pre-snap rect is stashed so the next
// drag-away restores it. Zones (faithful to the odysseus source, which keeps
// only top=maximize + right-half + bottom-half — left-half/corner snaps were
// disabled there): top strip → maximize, right edge → right-half, bottom edge
// → bottom-half. The left edge is the rail/sidebar, so a left-half snap is
// included only when the pointer is past the nav (parity with the safe-rect
// the odysseus source carves out, which never docks over the sidebar).

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { readPref, writePref } from "../util/storage";

export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type SnapZone = "maximize" | "left-half" | "right-half" | "bottom-half";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WindowControls {
  windowed: boolean;
  panelStyle: CSSProperties;
  onDragStart: (e: ReactPointerEvent) => void;
  onResizeStart: (dir: ResizeDir) => (e: ReactPointerEvent) => void;
  /** Fixed-position CSS rect for the translucent snap preview, or null when
   *  the drag is not over a snap zone. The owning view renders it. */
  snapGhost: CSSProperties | null;
}

const MIN_W = 360;
const MIN_H = 220;

// Mirror of tileManager.js EDGE_THRESHOLD_PX / TOP_FULL_STRIP_PX. The top strip
// triggers maximize; the side/bottom edges trigger the half snaps.
const EDGE_THRESHOLD_PX = 24;
const TOP_FULL_STRIP_PX = 8;
// Desktop only — the odysseus source excludes tiling at <=768px (swipe UX).
const DESKTOP_MIN_W = 768;
// Left navigation width (icon rail 48px + sidebar 240px). The odysseus
// safe-rect carves the nav out of the left edge so windows never dock over it;
// we approximate with the rail width as the always-present floor.
const RAIL_W = 48;
const SIDEBAR_W = 240;
const SAFE_PAD = 4;

interface SnapTarget {
  zone: SnapZone;
  rect: Rect;
}

// The safe area windows tile into: the viewport minus the left nav rail/sidebar
// and a small inset (parity with tileManager.js `_viewportSafeRect`). We can't
// read live DOM widths from a pure hook, so we treat the rail as the always-on
// left floor; the left-half zone additionally requires the pointer to be past
// the (rail + sidebar) band so it never lands over the nav.
function safeRect(): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  return {
    left: RAIL_W + SAFE_PAD,
    top: SAFE_PAD,
    right: window.innerWidth - SAFE_PAD,
    bottom: window.innerHeight - SAFE_PAD,
  };
}

// Compute the snap target under the pointer, or null when none. Faithful to
// tileManager.js `_zoneForPointer`: top strip → maximize, right edge →
// right-half, bottom edge → bottom-half, plus a guarded left-half (only when
// the pointer has cleared the full nav band, since the rail/sidebar live there).
function zoneForPointer(x: number, y: number): SnapTarget | null {
  const safe = safeRect();
  const w = safe.right - safe.left;
  const h = safe.bottom - safe.top;
  if (y <= safe.top + TOP_FULL_STRIP_PX) {
    return { zone: "maximize", rect: { x: safe.left, y: safe.top, w, h } };
  }
  if (x >= safe.right - EDGE_THRESHOLD_PX) {
    return {
      zone: "right-half",
      rect: { x: safe.left + w / 2, y: safe.top, w: w / 2, h },
    };
  }
  if (x <= RAIL_W + SIDEBAR_W + EDGE_THRESHOLD_PX) {
    return {
      zone: "left-half",
      rect: { x: safe.left, y: safe.top, w: w / 2, h },
    };
  }
  if (y >= safe.bottom - EDGE_THRESHOLD_PX) {
    return {
      zone: "bottom-half",
      rect: { x: safe.left, y: safe.top + h / 2, w, h: h / 2 },
    };
  }
  return null;
}

function ghostStyle(rect: Rect): CSSProperties {
  return {
    position: "fixed",
    left: rect.x,
    top: rect.y,
    width: rect.w,
    height: rect.h,
  };
}

export function useWindowControls(
  storageKey: string,
  defaults: { w: number; h: number },
): WindowControls {
  const [rect, setRect] = useState<Rect | null>(() =>
    readPref<Rect | null>(storageKey, null),
  );
  const rectRef = useRef<Rect | null>(rect);
  rectRef.current = rect;

  const [snapGhost, setSnapGhost] = useState<CSSProperties | null>(null);

  // The rect the window had before it snapped to a zone — restored on the next
  // drag-away (tileManager.js `_tilePreSnap`). Null when not currently snapped.
  const preSnapRef = useRef<Rect | null>(null);

  // Lazily seed a centered rect from the viewport on first interaction.
  const ensureRect = useCallback((): Rect => {
    if (rectRef.current) return rectRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(defaults.w, vw - 40);
    const h = Math.min(defaults.h, vh - 40);
    const seeded: Rect = {
      x: Math.max(20, Math.round((vw - w) / 2)),
      y: Math.max(20, Math.round((vh - h) / 2)),
      w,
      h,
    };
    rectRef.current = seeded;
    setRect(seeded);
    return seeded;
  }, [defaults.w, defaults.h]);

  const persist = useCallback(() => {
    if (rectRef.current) writePref(storageKey, rectRef.current);
  }, [storageKey]);

  const onDragStart = useCallback(
    (e: ReactPointerEvent) => {
      // Don't start a drag from an interactive control inside the header.
      if (
        (e.target as HTMLElement).closest("button, input, select, textarea, a")
      )
        return;
      e.preventDefault();
      const start = ensureRect();
      const desktop = window.innerWidth > DESKTOP_MIN_W;
      const sx = e.clientX;
      const sy = e.clientY;
      // If the drag begins on an already-snapped window, peel back to the
      // pre-snap geometry as the anchor so the move feels like un-snapping
      // (tileManager.js `_unsnap` on first significant move).
      const anchor = preSnapRef.current ?? start;
      preSnapRef.current = null;
      setSnapGhost(null);
      let activeTarget: SnapTarget | null = null;
      const onMove = (ev: PointerEvent) => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const next: Rect = {
          ...anchor,
          x: Math.min(Math.max(0, anchor.x + (ev.clientX - sx)), vw - 80),
          y: Math.min(Math.max(0, anchor.y + (ev.clientY - sy)), vh - 40),
        };
        rectRef.current = next;
        setRect(next);
        if (desktop) {
          const target = zoneForPointer(ev.clientX, ev.clientY);
          activeTarget = target;
          setSnapGhost(target ? ghostStyle(target.rect) : null);
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setSnapGhost(null);
        if (activeTarget) {
          // Stash the pre-snap rect so the next drag-away restores it, then
          // snap the panel to fill the zone (tileManager.js `_applySnap`).
          preSnapRef.current = rectRef.current ?? anchor;
          const snapped = activeTarget.rect;
          rectRef.current = snapped;
          setRect(snapped);
        }
        persist();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [ensureRect, persist],
  );

  const onResizeStart = useCallback(
    (dir: ResizeDir) => (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const start = ensureRect();
      // A manual resize breaks any snap, so forget the pre-snap rect.
      preSnapRef.current = null;
      const sx = e.clientX;
      const sy = e.clientY;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        let { x, y, w, h } = start;
        if (dir.includes("e")) w = Math.max(MIN_W, start.w + dx);
        if (dir.includes("s")) h = Math.max(MIN_H, start.h + dy);
        if (dir.includes("w")) {
          w = Math.max(MIN_W, start.w - dx);
          x = start.x + (start.w - w);
        }
        if (dir.includes("n")) {
          h = Math.max(MIN_H, start.h - dy);
          y = start.y + (start.h - h);
        }
        const next: Rect = { x, y, w, h };
        rectRef.current = next;
        setRect(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        persist();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [ensureRect, persist],
  );

  const panelStyle: CSSProperties = rect
    ? {
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        margin: 0,
        maxWidth: "none",
        maxHeight: "none",
      }
    : {};

  return {
    windowed: rect !== null,
    panelStyle,
    onDragStart,
    onResizeStart,
    snapGhost,
  };
}
