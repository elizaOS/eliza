/**
 * LifeOpsResizableSidebar - drag-to-resize wrapper for a sidebar panel.
 *
 * Renders children inside a width-controlled shell with a hit-targeted
 * drag handle on the trailing edge. Width persists to localStorage under
 * the supplied storage key and snaps to configurable bounds.
 */
import {
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export interface LifeOpsResizableSidebarProps {
  children: ReactNode;
  /** localStorage key for persisting the width (in px). */
  storageKey: string;
  /** Default width in px when nothing is stored. */
  defaultWidth: number;
  /** Minimum width in px allowed by the drag. */
  minWidth?: number;
  /** Maximum width in px allowed by the drag. */
  maxWidth?: number;
  /** Which edge to drag from. Defaults to "right" (trailing edge). */
  side?: "left" | "right";
  /** Extra classes for the outer shell. */
  className?: string;
  /** data-testid applied to the outer shell. */
  testId?: string;
}

function readStoredWidth(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredWidth(key: string, width: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(Math.round(width)));
  } catch {
    /* ignore */
  }
}

export function LifeOpsResizableSidebar({
  children,
  storageKey,
  defaultWidth,
  minWidth = 220,
  maxWidth = 520,
  side = "right",
  className,
  testId,
}: LifeOpsResizableSidebarProps) {
  const [width, setWidth] = useState<number>(() =>
    readStoredWidth(storageKey, defaultWidth),
  );
  const startStateRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );

  const handleMove = useCallback(
    (event: PointerEvent) => {
      const state = startStateRef.current;
      if (!state) return;
      const delta = event.clientX - state.startX;
      const next =
        side === "right" ? state.startWidth + delta : state.startWidth - delta;
      const clamped = Math.min(Math.max(next, minWidth), maxWidth);
      setWidth(clamped);
    },
    [maxWidth, minWidth, side],
  );

  const handleUp = useCallback(
    (event: PointerEvent) => {
      const state = startStateRef.current;
      startStateRef.current = null;
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (state) {
        const delta = event.clientX - state.startX;
        const final =
          side === "right"
            ? state.startWidth + delta
            : state.startWidth - delta;
        writeStoredWidth(
          storageKey,
          Math.min(Math.max(final, minWidth), maxWidth),
        );
      }
    },
    [handleMove, maxWidth, minWidth, side, storageKey],
  );

  const handleDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      startStateRef.current = {
        startX: event.clientX,
        startWidth: width,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [handleMove, handleUp, width],
  );

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [handleMove, handleUp]);

  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.shiftKey ? 32 : 8;
      const direction =
        side === "right"
          ? event.key === "ArrowRight"
            ? 1
            : -1
          : event.key === "ArrowRight"
            ? -1
            : 1;
      setWidth((current) => {
        const next = Math.min(
          Math.max(current + direction * step, minWidth),
          maxWidth,
        );
        writeStoredWidth(storageKey, next);
        return next;
      });
    },
    [maxWidth, minWidth, side, storageKey],
  );

  return (
    <div
      data-testid={testId}
      className={[
        "relative flex h-full shrink-0",
        side === "right" ? "flex-row" : "flex-row-reverse",
        className ?? "",
      ].join(" ")}
      style={{ width: `${width}px` }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
      <div
        role="slider"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={handleDown}
        onKeyDown={handleKey}
        className={[
          "group relative z-10 flex w-1 shrink-0 cursor-col-resize items-center justify-center",
          "hover:bg-accent/15 focus-visible:bg-accent/20 focus-visible:outline-none",
        ].join(" ")}
      >
        <span
          aria-hidden
          className="absolute inset-y-0 -left-1.5 right-auto w-4"
        />
        <span
          aria-hidden
          className="h-12 w-0.5 rounded-full bg-transparent transition-colors group-hover:bg-accent/50 group-focus-visible:bg-accent/60"
        />
      </div>
    </div>
  );
}
