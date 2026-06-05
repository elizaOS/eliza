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
// MINIMIZE (modalManager.js port): pass a 3rd `meta` arg ({ label, icon }) and
// the hook registers the window into the WindowManager registry on mount
// (unregister on unmount). It then reads `minimized` from the manager and
// exposes `minimize()` / `restore()` that flip that flag; the MinimizedDock
// renders a chip per minimized window. The view gates its own render on
// `win.minimized` (returns null while minimized) and the dock click restores
// it. Used OUTSIDE a WindowManagerProvider the minimize surface degrades to a
// disabled state (minimized stays false, minimize/restore do nothing) so a standalone
// view never breaks. The `meta` arg is OPTIONAL and additive — the existing
// two-arg call sites keep their exact behaviour with minimize simply unwired.
//
// TILING (tileManager.js port): while dragging the title bar, when the pointer
// nears a screen edge we compute a snap target and expose `snapGhost` (a fixed
// CSS rect) so a translucent preview can render. On pointer-up over a zone the
// panel rect snaps to that target; the pre-snap rect is stashed so the next
// drag-away restores it. Zones are faithful to tileManager.js `_zoneForPointer`,
// which keeps ONLY top strip → maximize, right edge → right-half, bottom edge →
// bottom-half. The left-half and corner snaps are deliberately disabled in the
// source (the nav rail/sidebar lives on the left, so docking over it is awkward),
// so they are omitted here too.

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { readPref, writePref } from "../util/storage";
import { useWindowManager, type WindowMeta } from "../WindowManager.context";

export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type SnapZone = "maximize" | "right-half" | "bottom-half";

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
  /** True while the window is minimized to the dock. Always false when no
   *  `meta` was passed or when used outside a WindowManagerProvider — so a
   *  view that never gates on it is unaffected. */
  minimized: boolean;
  /** Minimize the window to the dock chip. No-op without a manager/meta. */
  minimize: () => void;
  /** Restore the window from the dock. No-op without a manager/meta. */
  restore: () => void;
}

const MIN_W = 360;
const MIN_H = 220;

// Mirror of tileManager.js EDGE_THRESHOLD_PX / TOP_FULL_STRIP_PX. The top strip
// triggers maximize; the side/bottom edges trigger the half snaps.
const EDGE_THRESHOLD_PX = 24;
const TOP_FULL_STRIP_PX = 8;
// Mirror of tileManager.js `Math.hypot(dx, dy) < 6` guard: a snapped window
// only peels back to its pre-snap geometry once the drag passes this distance,
// so a sub-pixel nudge on a snapped panel doesn't teleport it back to size.
const UNSNAP_MOVE_PX = 6;
// Desktop only — the odysseus source excludes tiling at <=768px (swipe UX).
const DESKTOP_MIN_W = 768;
// Left navigation width (icon rail). The odysseus safe-rect carves the nav out
// of the left edge so windows never dock over it; we approximate with the rail
// width as the always-present floor (parity with tileManager.js, which never
// snaps to the left edge — only maximize / right-half / bottom-half).
const RAIL_W = 48;
const SAFE_PAD = 4;

interface SnapTarget {
  zone: SnapZone;
  rect: Rect;
}

// The safe area windows tile into: the viewport minus the left nav rail and a
// small inset (parity with tileManager.js `_viewportSafeRect`). We can't read
// live DOM widths from a pure hook, so we treat the rail as the always-on left
// floor; snaps only ever fill from this left edge rightward (maximize /
// right-half / bottom-half), so they never land over the nav.
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
// right-half, bottom edge → bottom-half. The left edge / corners are
// deliberately not snap zones (the source disabled them — the nav lives there).
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
  meta?: WindowMeta,
): WindowControls {
  const [rect, setRect] = useState<Rect | null>(() =>
    readPref<Rect | null>(storageKey, null),
  );

  // Minimize-to-dock wiring (modalManager.js). The manager is null when this
  // hook runs outside a WindowManagerProvider; in that case minimize/restore
  // become no-ops and `minimized` is permanently false, so a standalone view
  // (or a two-arg call site that passes no meta) is entirely unaffected.
  const manager = useWindowManager();
  // Register on mount / unregister on unmount — only when a view opts in by
  // passing meta. Keying the effect on the meta fields (not the object
  // identity) lets a view pass an inline `{ label, icon }` without thrashing
  // register on every render. The manager API methods are stable callbacks.
  const label = meta?.label;
  const icon = meta?.icon;
  const register = manager?.register;
  const unregister = manager?.unregister;
  // Keep the latest onClose in a ref and register a STABLE wrapper, so the
  // dock chip's × can close the view (not just un-minimize it) without the
  // changing onClose identity re-running the register effect every render.
  const onCloseRef = useRef(meta?.onClose);
  onCloseRef.current = meta?.onClose;
  const stableOnClose = useCallback(() => onCloseRef.current?.(), []);
  useEffect(() => {
    if (!register || !unregister || label === undefined || icon === undefined) {
      return;
    }
    register(storageKey, { label, icon, onClose: stableOnClose });
    return () => unregister(storageKey);
  }, [register, unregister, storageKey, label, icon, stableOnClose]);

  const hasMinimize =
    manager !== null && label !== undefined && icon !== undefined;
  const minimized = hasMinimize && manager.isMinimized(storageKey);

  const minimize = useCallback(() => {
    if (manager && hasMinimize) {
      // Detach any in-flight drag/resize first — otherwise the window-level
      // listeners keep mutating rect on the now-hidden panel. detach() also
      // clears activeGestureRef; clear the snap preview too so an in-flight
      // drag doesn't leave a ghost floating over the dock.
      activeGestureRef.current?.();
      setSnapGhost(null);
      manager.setMinimized(storageKey, true);
    }
  }, [manager, hasMinimize, storageKey]);

  const restore = useCallback(() => {
    if (manager && hasMinimize) manager.setMinimized(storageKey, false);
  }, [manager, hasMinimize, storageKey]);
  const rectRef = useRef<Rect | null>(rect);
  rectRef.current = rect;

  const [snapGhost, setSnapGhost] = useState<CSSProperties | null>(null);

  // The rect the window had before it snapped to a zone — restored on the next
  // drag-away (tileManager.js `_tilePreSnap`). Null when not currently snapped.
  const preSnapRef = useRef<Rect | null>(null);

  // Teardown for the in-flight drag/resize gesture. A gesture registers its
  // window listeners while active and stashes the remover here so an unmount
  // mid-drag detaches them — otherwise the listeners leak and keep calling the
  // state setters after the host view is gone.
  const activeGestureRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      activeGestureRef.current?.();
      activeGestureRef.current = null;
    },
    [],
  );

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
        e.target instanceof Element &&
        e.target.closest("button, input, select, textarea, a")
      )
        return;
      e.preventDefault();
      const start = ensureRect();
      const desktop = window.innerWidth > DESKTOP_MIN_W;
      const sx = e.clientX;
      const sy = e.clientY;
      // Anchor the drag on the window's CURRENT (possibly snapped) geometry.
      // If it began snapped we don't peel back to the pre-snap rect yet — that
      // only happens once the pointer travels past UNSNAP_MOVE_PX, so a tiny
      // nudge on a snapped window doesn't teleport it (tileManager.js defers
      // `_unsnap` behind its `Math.hypot(dx, dy) < 6` guard).
      let anchor = start;
      const pendingUnsnap = preSnapRef.current;
      setSnapGhost(null);
      let activeTarget: SnapTarget | null = null;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        // First significant move on a snapped window: swap the anchor to the
        // stashed pre-snap rect and clear it, so from here the drag follows the
        // pointer at the restored size (tileManager.js `_unsnap`).
        if (pendingUnsnap && Math.hypot(dx, dy) > UNSNAP_MOVE_PX) {
          anchor = pendingUnsnap;
          preSnapRef.current = null;
        }
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const next: Rect = {
          ...anchor,
          x: Math.min(Math.max(0, anchor.x + dx), vw - 80),
          y: Math.min(Math.max(0, anchor.y + dy), vh - 40),
        };
        rectRef.current = next;
        setRect(next);
        if (desktop) {
          const target = zoneForPointer(ev.clientX, ev.clientY);
          activeTarget = target;
          setSnapGhost(target ? ghostStyle(target.rect) : null);
        }
      };
      const detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        // An OS pointercancel (touch interrupt, context menu, scroll takeover)
        // ends the gesture without a pointerup, so it must run onUp too — and
        // be torn down here — or the listeners leak and the panel keeps
        // following a dead pointer (windowDrag.js pairs touchcancel/touchend).
        window.removeEventListener("pointercancel", onUp);
        activeGestureRef.current = null;
      };
      const onUp = () => {
        detach();
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
      activeGestureRef.current = detach;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
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
      const detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        // pointercancel ends the resize without a pointerup; tear down here too
        // so we persist the final rect and don't leak listeners onto the window
        // (windowResize.js pairs touchcancel/touchend for the same reason).
        window.removeEventListener("pointercancel", onUp);
        activeGestureRef.current = null;
      };
      const onUp = () => {
        detach();
        persist();
      };
      activeGestureRef.current = detach;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
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
    minimized,
    minimize,
    restore,
  };
}
