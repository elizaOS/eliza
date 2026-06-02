// Window-manager controls for the odysseus tool views (static/js/windowDrag.js
// + windowResize.js). Turns a centered overlay panel into a draggable +
// edge/corner-resizable floating window whose position/size persist per view.
//
// Usage: const win = useWindowControls("win-compare", { w: 1180, h: 880 });
//   - overlay:  className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
//   - panel:    style={win.panelStyle}
//   - header:   onPointerDown={win.onDragStart}   (drags ignore buttons/inputs)
//   - inside panel: <ResizeHandles controls={win} />
// Until the user first drags/resizes, `windowed` is false and the panel keeps
// its default centered CSS — so nothing changes visually until interacted with.

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { readPref, writePref } from "../util/storage";

export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

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
}

const MIN_W = 360;
const MIN_H = 220;

export function useWindowControls(
  storageKey: string,
  defaults: { w: number; h: number },
): WindowControls {
  const [rect, setRect] = useState<Rect | null>(() =>
    readPref<Rect | null>(storageKey, null),
  );
  const rectRef = useRef<Rect | null>(rect);
  rectRef.current = rect;

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
      const sx = e.clientX;
      const sy = e.clientY;
      const onMove = (ev: PointerEvent) => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const next: Rect = {
          ...start,
          x: Math.min(Math.max(0, start.x + (ev.clientX - sx)), vw - 80),
          y: Math.min(Math.max(0, start.y + (ev.clientY - sy)), vh - 40),
        };
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

  const onResizeStart = useCallback(
    (dir: ResizeDir) => (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const start = ensureRect();
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

  return { windowed: rect !== null, panelStyle, onDragStart, onResizeStart };
}
