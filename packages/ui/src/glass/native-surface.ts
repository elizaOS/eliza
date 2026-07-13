/**
 * Polymorphic native-surface layer: ONE hook + driver interface that anchors a
 * real native platform view (iOS `UIView` / Android `View` / macOS `NSView`) to
 * a DOM element's live rect, so every native chat surface — glass, transcript,
 * and the composer input — shares one lifecycle (probe → attach → rAF-coalesced
 * rect sync → prop diffs → detach) with zero duplication.
 *
 * The seam is TS/React only. Each surface implements a compact
 * `NativeSurfaceDriver`; the TRANSPORT (a Capacitor plugin on mobile, an
 * Electrobun RPC group on desktop) stays private to the driver so the hook never
 * sees it and web/desktop-without-native degrade to DOM by the driver returning
 * `null` from `attach`. This generalizes the proven `useNativeGlassAnchor`
 * (packages/ui/src/glass/GlassSurface.tsx) — the rAF-coalesced ResizeObserver +
 * window-resize sync is lifted here verbatim so no surface re-implements it.
 */

import { useEffect, useId, useRef, useState } from "react";

/**
 * The platform behind a native surface, or null off-native (web / desktop
 * without a native driver). Desktop splits into three so a driver can answer
 * "macOS yes, Windows/Linux not yet" and fall back to DOM per-OS.
 */
export type NativePlatform =
  | "ios"
  | "android"
  | "macos"
  | "windows"
  | "linux"
  | null;

/**
 * The DOM anchor's live geometry. `cornerRadius` is read from the element's
 * computed `border-radius` each frame (the chat sheet morphs its corners), so a
 * refracting surface (glass) can track it; surfaces that don't care ignore it.
 */
export interface NativeSurfaceGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  cornerRadius: number;
}

/** A live, mounted native surface. `Props` is surface-specific. */
export interface NativeSurfaceHandle<Props> {
  /** Move/resize to the anchor's new geometry. Called ≤once per frame. */
  updateGeometry(geo: NativeSurfaceGeometry): void | Promise<void>;
  /** Patch surface props (placeholder/disabled/draft/…). No-op for material. */
  setProps(patch: Partial<Props>): void | Promise<void>;
  /** Tear down the native view. */
  detach(): void | Promise<void>;
}

/**
 * The per-surface, per-transport implementation — the ONLY thing a platform
 * contributes. One driver == one native plugin (or one desktop RPC group).
 */
export interface NativeSurfaceDriver<Props, Event = never> {
  /** Stable id for diagnostics ("glass" | "transcript" | "composer"). */
  readonly name: string;
  /** Memoized capability probe; false → the hook stays DOM (no attach). */
  isAvailable(): Promise<boolean>;
  /**
   * Mount at `geo` with initial `props`, wiring `onEvent`. Returns `null`
   * off-native (web / unsupported OS) so the caller degrades to DOM. `onEvent`
   * is unused for material surfaces (`Event = never`).
   */
  attach(
    id: string,
    geo: NativeSurfaceGeometry,
    props: Props,
    onEvent: (event: Event) => void,
  ): Promise<NativeSurfaceHandle<Props> | null>;
}

/** Read the anchor's geometry (rect + computed corner radius). */
function geometryOf(el: HTMLElement): NativeSurfaceGeometry {
  const r = el.getBoundingClientRect();
  const cornerRadius =
    Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  return { x: r.x, y: r.y, width: r.width, height: r.height, cornerRadius };
}

/**
 * Anchor `driver`'s native surface to `ref`'s live rect while `enabled`.
 *
 * Lifecycle (lifted from `useNativeGlassAnchor`): probe availability → attach at
 * the current geometry with `props` and an `onEvent` bridge → keep the native
 * rect synced through a single `requestAnimationFrame`-coalesced
 * `ResizeObserver` + `window 'resize'` handler (never more than one
 * `updateGeometry` per frame, even during the maximize morph) → push `setProps`
 * whenever `props` changes → detach on unmount / when `enabled` flips false.
 * Callers must anchor to STABLE chrome (a sheet at rest, the composer band) —
 * position sync is per-frame but the native view cannot chase scrolling content.
 *
 * `enabled=false` short-circuits to a no-op so the surface stays pure DOM.
 * Returns `{ active }` — true only once a native handle is really mounted.
 */
export function useNativePlatformSurface<Props, Event = never>(
  driver: NativeSurfaceDriver<Props, Event>,
  opts: {
    ref: React.RefObject<HTMLElement | null>;
    enabled: boolean;
    props: Props;
    onEvent?: (event: Event) => void;
  },
): { active: boolean } {
  const { ref, enabled, props, onEvent } = opts;
  const regionId = useId();
  const [active, setActive] = useState(false);

  // Latest props/onEvent without re-running the mount effect: attach reads the
  // seed synchronously; setProps below reacts to changes; onEvent is always the
  // freshest callback so React state closures never go stale.
  const propsRef = useRef(props);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Live handle shared by the mount effect (owner) and the props effect.
  const handleRef = useRef<NativeSurfaceHandle<Props> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: props/onEvent are seeded via refs and pushed by the setProps effect below, so a prop change must NOT re-run this mount effect (that would remount/thrash the native surface).
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    let raf = 0;
    // Seed props at attach time from the current value so the very first frame
    // is correct even before the props effect below has run.
    propsRef.current = props;

    void driver
      .attach(regionId, geometryOf(el), propsRef.current, (event) =>
        onEventRef.current?.(event),
      )
      .then((handle) => {
        if (cancelled || !handle) {
          void handle?.detach();
          return;
        }
        handleRef.current = handle;
        setActive(true);
      });

    const sync = () => {
      if (raf || !handleRef.current) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const node = ref.current;
        if (node) void handleRef.current?.updateGeometry(geometryOf(node));
      });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    window.addEventListener("resize", sync);

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", sync);
      void handleRef.current?.detach();
      handleRef.current = null;
      setActive(false);
    };
    // `props`/`onEvent` are intentionally excluded (see the ignore above the
    // hook): they flow via refs + the setProps effect below.
  }, [driver, enabled, ref, regionId]);

  // Push prop changes to the live handle (no remount). Skipped while inactive.
  useEffect(() => {
    propsRef.current = props;
    if (handleRef.current) void handleRef.current.setProps(props);
  }, [props]);

  return { active };
}
