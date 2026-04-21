import { cn } from "@elizaos/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RightSideChatPanelProps {
  storageKey: string;
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  collapsedByDefault?: boolean;
  children: ReactNode;
  onCollapsedChange?: (v: boolean) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const COLLAPSED_RAIL_WIDTH = 40;
const SNAP_THRESHOLD = 30;

interface PersistedState {
  width: number;
  collapsed: boolean;
}

function readPersistedState(
  storageKey: string,
  defaultWidth: number,
  collapsedByDefault: boolean,
): PersistedState {
  if (typeof window === "undefined") {
    return { width: defaultWidth, collapsed: collapsedByDefault };
  }
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return { width: defaultWidth, collapsed: collapsedByDefault };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return { width: defaultWidth, collapsed: collapsedByDefault };
    }
    const record = parsed as Record<string, unknown>;
    const width =
      typeof record.width === "number" && record.width > 0
        ? record.width
        : defaultWidth;
    const collapsed =
      typeof record.collapsed === "boolean"
        ? record.collapsed
        : collapsedByDefault;
    return { width, collapsed };
  } catch {
    return { width: defaultWidth, collapsed: collapsedByDefault };
  }
}

function writePersistedState(storageKey: string, state: PersistedState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable in some contexts — fail silently
  }
}

// ── Snap logic ────────────────────────────────────────────────────────────────

function snapWidth(rawWidth: number, presets: readonly number[]): number {
  for (const preset of presets) {
    if (Math.abs(rawWidth - preset) <= SNAP_THRESHOLD) {
      return preset;
    }
  }
  return rawWidth;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function RightSideChatPanel({
  storageKey,
  minWidth = 280,
  maxWidth = 720,
  defaultWidth = 384,
  collapsedByDefault = false,
  children,
  onCollapsedChange,
}: RightSideChatPanelProps) {
  const widePreset = maxWidth - 80;
  // Presets: collapsed rail, default, wide
  const presets = [COLLAPSED_RAIL_WIDTH, defaultWidth, widePreset] as const;

  const [state, setState] = useState<PersistedState>(() =>
    readPersistedState(storageKey, defaultWidth, collapsedByDefault),
  );

  const { width, collapsed } = state;

  // Hydrate from localStorage on mount (SSR-safe)
  useEffect(() => {
    const hydrated = readPersistedState(
      storageKey,
      defaultWidth,
      collapsedByDefault,
    );
    setState(hydrated);
  }, [collapsedByDefault, defaultWidth, storageKey]);

  const applyState = useCallback(
    (next: PersistedState) => {
      setState(next);
      writePersistedState(storageKey, next);
    },
    [storageKey],
  );

  const setCollapsed = useCallback(
    (next: boolean) => {
      applyState({ width: state.width, collapsed: next });
      onCollapsedChange?.(next);
    },
    [applyState, onCollapsedChange, state.width],
  );

  // ── Drag handle ───────────────────────────────────────────────────────────
  const dragStartXRef = useRef<number>(0);
  const dragStartWidthRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);
  const draggingRef = useRef(false);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      draggingRef.current = true;
      dragStartXRef.current = event.clientX;
      dragStartWidthRef.current = state.width;
    },
    [collapsed, state.width],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      const delta = dragStartXRef.current - event.clientX;
      const rawWidth = Math.max(
        minWidth,
        Math.min(maxWidth, dragStartWidthRef.current + delta),
      );
      const snapped = snapWidth(rawWidth, presets);

      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        applyState({ width: snapped, collapsed: false });
      });
    },
    [applyState, maxWidth, minWidth, presets],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;

      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      const delta = dragStartXRef.current - event.clientX;
      const rawWidth = Math.max(
        minWidth,
        Math.min(maxWidth, dragStartWidthRef.current + delta),
      );
      // Snap on release (same presets)
      const snapped = snapWidth(rawWidth, presets);

      if (snapped <= COLLAPSED_RAIL_WIDTH) {
        applyState({ width: dragStartWidthRef.current, collapsed: true });
        onCollapsedChange?.(true);
      } else {
        applyState({ width: snapped, collapsed: false });
      }
    },
    [applyState, maxWidth, minWidth, onCollapsedChange, presets],
  );

  // Clean up any pending RAF on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "[") {
        event.preventDefault();
        setCollapsed(!collapsed);
      } else if (event.key === "]") {
        event.preventDefault();
        if (collapsed) {
          applyState({ width: defaultWidth, collapsed: false });
          onCollapsedChange?.(false);
        } else if (Math.abs(width - defaultWidth) < SNAP_THRESHOLD) {
          applyState({ width: widePreset, collapsed: false });
        } else {
          applyState({ width: defaultWidth, collapsed: false });
        }
      }
    },
    [
      applyState,
      collapsed,
      defaultWidth,
      onCollapsedChange,
      setCollapsed,
      width,
      widePreset,
    ],
  );

  const panelWidth = collapsed ? COLLAPSED_RAIL_WIDTH : width;

  return (
    <aside
      className={cn(
        "relative flex h-full shrink-0 flex-col self-stretch border-l border-border/30 bg-bg transition-[width] duration-200",
        collapsed ? "overflow-hidden" : "",
      )}
      style={{ width: panelWidth }}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: panel needs focus for keyboard shortcuts
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Chat panel"
    >
      {/* Drag handle */}
      {!collapsed && (
        <div
          className="absolute left-0 top-0 h-full w-1 cursor-col-resize select-none hover:bg-accent/30 active:bg-accent/50"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          aria-hidden="true"
        />
      )}

      {/* Collapse / expand toggle — visible in both states */}
      <div className="flex h-10 shrink-0 items-center justify-end border-b border-border/30 px-2">
        {collapsed ? (
          <button
            type="button"
            className="mx-auto flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-card/60 hover:text-txt"
            aria-label="Expand panel"
            onClick={() => setCollapsed(false)}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-card/60 hover:text-txt"
            aria-label="Collapse panel"
            onClick={() => setCollapsed(true)}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Content — hidden when collapsed */}
      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      )}
    </aside>
  );
}
