/**
 * TS side of the `GlassBridge` Capacitor plugin: attaches REAL native material
 * behind anchored regions of the webview — iOS 26 `UIGlassEffect` on a
 * `UIVisualEffectView` (Swift half:
 * `packages/app-core/platforms/ios/App/App/GlassBridge.swift`) and the
 * Material dynamic-palette panel on Android 12+ (Java half:
 * `packages/app-core/platforms/android/.../GlassBridgePlugin.java`). The JS
 * API and rect contract are identical on both platforms. Below iOS 26 /
 * Android 12 (or off-Capacitor) every call resolves as a no-op and callers
 * stay on the CSS tier.
 *
 * Deliberately reads the bridge-injected `globalThis.Capacitor` instead of
 * statically importing `@capacitor/core`: this module is re-exported through
 * the `@elizaos/ui` barrel, which server-side plugins load under plain node in
 * the production Docker image where `@capacitor/core` is not shipped (#15221).
 *
 * True glass can never render INSIDE the DOM — WKWebView composites its own
 * pixels. The pattern here is a native effect view positioned to a web-reported
 * rect, layered under a transparent region of the page. Position sync is
 * per-call, not per-frame, so callers must anchor glass to STABLE chrome (the
 * composer pill, a sheet at rest, a header) — never to scrolling content.
 */

/** Mirrors the Swift plugin's attach options. */
export interface NativeGlassOptions {
  /** Caller-chosen stable id; reuse to move/replace a region. */
  id: string;
  /** Viewport-relative CSS pixels (from getBoundingClientRect). */
  rect: { x: number; y: number; width: number; height: number };
  cornerRadius: number;
  /** Optional tint (CSS color); omit for the system-neutral material. */
  tintColor?: string;
  /**
   * UIGlassEffect.isInteractive — touch grow/shimmer. Mount-time only: the
   * system effect cannot toggle it after creation; changing it requires
   * detach + attach.
   */
  interactive?: boolean;
  colorScheme?: "light" | "dark" | "system";
}

/** Native-truth readback of one region, for diagnostics and device e2e. */
export interface NativeGlassRegionState {
  exists: boolean;
  regionCount: number;
  /** Present when `exists`: panel z-order relative to the WebView. */
  attachedBelowWebView?: boolean;
  /** Present when `exists`: REAL view geometry (device px / iOS points). */
  rect?: { x: number; y: number; width: number; height: number };
}

interface GlassBridgePlugin {
  attachGlass(options: NativeGlassOptions): Promise<{ attached: boolean }>;
  updateRect(options: {
    id: string;
    rect: NativeGlassOptions["rect"];
  }): Promise<void>;
  detachGlass(options: { id: string }): Promise<void>;
  /** UIGlassContainerEffect merge distance for sibling regions. */
  setGrouping(options: { spacing: number }): Promise<void>;
  isAvailable(): Promise<{ available: boolean }>;
  /**
   * Reads the region's REAL native view state (existence, count, z-order,
   * geometry) — the seam device e2e uses to prove the lifecycle against
   * native truth instead of resolved promises.
   */
  getRegionState(options: { id: string }): Promise<NativeGlassRegionState>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  registerPlugin?: <T>(name: string) => T;
  Plugins?: Record<string, unknown>;
}

function capacitorGlobal(): CapacitorGlobal | null {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor ?? null;
}

let cached: GlassBridgePlugin | null | undefined;

/**
 * The plugin proxy, or null off-native. Resolution is lazy and cached; the
 * proxy existing does NOT mean glass is available (an iOS 18 device registers
 * the plugin but `isAvailable()` answers false) — gate on `isNativeGlassAvailable`.
 */
export function glassBridge(): GlassBridgePlugin | null {
  if (cached !== undefined) return cached;
  const cap = capacitorGlobal();
  const platform = cap?.getPlatform?.();
  if (
    !cap?.isNativePlatform?.() ||
    (platform !== "ios" && platform !== "android")
  ) {
    cached = null;
    return cached;
  }
  try {
    cached = cap.registerPlugin
      ? cap.registerPlugin<GlassBridgePlugin>("GlassBridge")
      : ((cap.Plugins?.GlassBridge as GlassBridgePlugin | undefined) ?? null);
  } catch {
    // error-policy:J4 capability probe — an unregistered plugin IS the
    // "no native glass" answer; callers degrade to the CSS tier.
    cached = null;
  }
  return cached ?? null;
}

/**
 * One async probe, memoized: true only on iOS 26+ / Android 12+ with the
 * plugin present.
 */
let availability: Promise<boolean> | null = null;

export function isNativeGlassAvailable(): Promise<boolean> {
  if (availability) return availability;
  availability = (async () => {
    const bridge = glassBridge();
    if (!bridge) return false;
    try {
      return (await bridge.isAvailable()).available;
    } catch {
      // error-policy:J4 capability probe — a throwing bridge (older plugin
      // build, simulator quirk) is honestly "unavailable", never a crash.
      return false;
    }
  })();
  return availability;
}

/** Test seam: reset memoized plugin + availability between cases. */
export function resetGlassBridgeForTests(): void {
  cached = undefined;
  availability = null;
}
