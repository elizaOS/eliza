/**
 * App registries — overlay-app and detail-extension registries.
 *
 * Runtime-agnostic registry state for full-screen overlay apps and app
 * detail-panel extensions. Both registries are anchored on a shared global
 * slot so every module copy in a bundle (Node-builtin shims, `global:
 * globalThis` defines, duplicated chunks) converges on one store.
 *
 * React is referenced only through erased `import type` specifiers, so this
 * module is safe to evaluate from a Node.js server boot path.
 */

import type { ComponentType, ReactElement } from "react";
import type { RegistryAppInfo } from "./apps.js";

// ---------------------------------------------------------------------------
// Overlay app API — contract for full-screen overlay applications.
// ---------------------------------------------------------------------------

/** Context passed to every full-screen overlay app by the host shell. */
export interface OverlayAppContext {
  /** Navigate back to the apps tab and close this overlay. */
  exitToApps: () => void;
  /** Current UI theme. */
  uiTheme: "light" | "dark";
  /** i18n translation function. */
  t: (key: string, opts?: Record<string, unknown>) => string;
}

/**
 * Full-screen overlay app definition.
 *
 * Implement this to create an app that renders as a full-screen overlay
 * on top of the main shell. The component owns its own resources and
 * lifecycle — load assets on mount, dispose on unmount.
 */
export interface OverlayApp {
  /** Unique app identifier (npm-style, e.g. "@elizaos/plugin-feed"). */
  readonly name: string;
  /** Display name shown in the apps catalog. */
  readonly displayName: string;
  /** Short description for the catalog card. */
  readonly description: string;
  /** Category for catalog filtering. */
  readonly category: string;
  /** Optional icon URL. */
  readonly icon: string | null;
  /** Optional hero image shown in app cards and chat widgets. */
  readonly heroImage?: string | null;
  /**
   * When true, the app should only appear in the catalog on ElizaOS Android.
   * Apps that wrap Android-only Capacitor native plugins (WiFi, Contacts,
   * Phone) set this so they are hidden on stock Android, iOS, desktop, and
   * web. Stock Android APKs do not expose these privileged OS-control surfaces.
   *
   * The platform check is performed by `getAvailableOverlayApps()`; the
   * registry itself accepts any platform's registrations so server-side
   * rendering and tests don't have to mock Capacitor.
   */
  readonly androidOnly?: boolean;
  /**
   * React component rendered as the full-screen overlay.
   * Receives context with exit callback, theme, and i18n.
   * Must handle its own resource lifecycle (load on mount, dispose on unmount).
   *
   * Provide EITHER `Component` (eager) OR `loader` (lazy). Prefer `loader` so
   * the app's component tree is only fetched when the window mounts; this
   * keeps the heavy per-app code out of the main entry chunk.
   */
  readonly Component?: (props: OverlayAppContext) => ReactElement;
  /**
   * Dynamic-import loader for the overlay component. When present, the host
   * shell wraps the resolved component in `React.lazy()` + `<Suspense>` so the
   * app's bundle is split out of the registration module.
   */
  readonly loader?: () => Promise<{
    default: ComponentType<OverlayAppContext>;
    cleanup?: () => void | Promise<void>;
  }>;
  /**
   * Called immediately before the component mounts.
   * Use for resource prefetching (e.g. VRM assets).
   */
  onLaunch?(): void | Promise<void>;
  /**
   * Called after the component unmounts.
   * Use for final resource cleanup beyond what component unmount handles.
   */
  onStop?(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// App detail-extension API — detail-panel extension components.
// ---------------------------------------------------------------------------

export interface AppDetailExtensionProps {
  app: RegistryAppInfo;
}

export type AppDetailExtensionComponent =
  ComponentType<AppDetailExtensionProps>;

// ---------------------------------------------------------------------------
// AOSP renderer detection.
//
// The Android framework appends the framework marker `ElizaOS/<tag>` only on
// Eliza-derived AOSP system images. White-label builds may append additional
// brand markers, but they still carry this base marker.
// ---------------------------------------------------------------------------

function userAgentHasElizaOSMarker(
  userAgent: string | null | undefined,
): boolean {
  if (typeof userAgent !== "string" || userAgent.length === 0) return false;
  return /\bElizaOS\/\S/.test(userAgent);
}

// ---------------------------------------------------------------------------
// Overlay app registry.
// ---------------------------------------------------------------------------

declare global {
  // A single global slot, declared on the shared global scope so it is visible
  // on both `window` (`Window & typeof globalThis`) and `globalThis`.
  var __elizaosOverlayAppRegistry__: Map<string, OverlayApp> | undefined;
}

// Anchor the registry on the real browser `window` when present, falling back
// to `globalThis`. The app build can hand a duplicated or shimmed `globalThis`
// to different chunks (Node-builtin shims + the `global: globalThis` define),
// so the copy a plugin uses to REGISTER an app and the copy the shell uses to
// READ it can otherwise see different `globalThis` objects — stranding the
// registration on a Map the reader never looks at. `window` is the single
// object every browser chunk shares. Resolve the host (and the Map) on every
// access — never freeze a Map reference at module scope — so all copies of this
// module converge on one shared registry regardless of evaluation order.
function getOverlayRegistryHost(): typeof globalThis {
  return typeof window !== "undefined" ? window : globalThis;
}

function getOverlayRegistry(): Map<string, OverlayApp> {
  const host = getOverlayRegistryHost();
  const existing = host.__elizaosOverlayAppRegistry__;
  if (existing) {
    return existing;
  }
  const next = new Map<string, OverlayApp>();
  host.__elizaosOverlayAppRegistry__ = next;
  return next;
}

/** Register an overlay app. Call at module scope. */
export function registerOverlayApp(app: OverlayApp): void {
  getOverlayRegistry().set(app.name, app);
}

/** Look up a registered overlay app by name. */
export function getOverlayApp(name: string): OverlayApp | undefined {
  return getOverlayRegistry().get(name);
}

/** Get all registered overlay apps. */
export function getAllOverlayApps(): OverlayApp[] {
  return Array.from(getOverlayRegistry().values());
}

/**
 * Get overlay apps that are available on the current platform. Filters
 * out `androidOnly: true` apps unless this is an AOSP Eliza-derived Android
 * build (ElizaOS or any white-label fork). Used by the apps
 * catalog UI so stock Android, iOS, desktop, and web users don't see
 * privileged OS-control tiles that launch into permanent error states.
 *
 * AOSP detection: the framework's `MainActivity.applyElizaOSUserAgentSuffix`
 * appends an `ElizaOS/<tag>` token to the WebView UA when `ro.elizaos.product`
 * is set by the product makefile. Every Eliza-derived AOSP image carries this
 * marker; white-label brands layer additional brand-specific
 * markers on top via `app.config.ts > android.userAgentMarkers`. Stock Android
 * APKs leave the UA untouched.
 *
 * Platform detection: when `Capacitor.getPlatform()` is available it is
 * preferred; otherwise the user-agent is inspected. Tests can pass an
 * explicit context.
 */
export interface OverlayAppAvailabilityContext {
  platform?: string;
  /**
   * True when this is an AOSP Eliza-derived Android build (any fork). When
   * unspecified, derived from `userAgent` by checking for the framework
   * `ElizaOS/<tag>` marker.
   */
  aospAndroid?: boolean;
  userAgent?: string;
}

export function getAvailableOverlayApps(
  context:
    | string
    | OverlayAppAvailabilityContext = detectOverlayAvailabilityContext(),
): OverlayApp[] {
  const availability =
    typeof context === "string"
      ? { platform: context, aospAndroid: false }
      : normalizeOverlayAvailabilityContext(context);
  const canShowAndroidOnly =
    availability.platform === "android" && availability.aospAndroid === true;
  return getAllOverlayApps().filter(
    (app) => canShowAndroidOnly || app.androidOnly !== true,
  );
}

function normalizeOverlayAvailabilityContext(
  context: OverlayAppAvailabilityContext,
): Required<OverlayAppAvailabilityContext> {
  const userAgent =
    context.userAgent ??
    (typeof navigator !== "undefined" ? navigator.userAgent : "");
  const platform = context.platform ?? detectPlatformForCatalog(userAgent);
  return {
    platform,
    aospAndroid:
      context.aospAndroid ??
      (platform === "android" && userAgentHasElizaOSMarker(userAgent)),
    userAgent,
  };
}

function detectOverlayAvailabilityContext(): Required<OverlayAppAvailabilityContext> {
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const platform = detectPlatformForCatalog(userAgent);
  return {
    platform,
    aospAndroid: platform === "android" && userAgentHasElizaOSMarker(userAgent),
    userAgent,
  };
}

function detectPlatformForCatalog(userAgent: string): string {
  type CapacitorGlobal = {
    Capacitor?: { getPlatform?: () => string };
  };
  const cap = (globalThis as CapacitorGlobal).Capacitor;
  const fromCap = cap?.getPlatform?.();
  if (fromCap) return fromCap;
  if (/Android/i.test(userAgent)) {
    return "android";
  }
  return "web";
}

/**
 * True when running on an AOSP Eliza-derived Android build (ElizaOS or any
 * white-label fork). Tests may pass an explicit context. Shared with
 * `catalog-loader.ts` so it can apply the same gate to installed/static apps,
 * not just overlay apps that happen to be registered already.
 */
export function isAospAndroid(
  context: OverlayAppAvailabilityContext = {},
): boolean {
  const availability = normalizeOverlayAvailabilityContext(context);
  return (
    availability.platform === "android" && availability.aospAndroid === true
  );
}

/** Check if an app name belongs to a registered overlay app. */
export function isOverlayApp(name: string): boolean {
  return getOverlayRegistry().has(name);
}

/** Convert an OverlayApp to a RegistryAppInfo for the apps catalog. */
export function overlayAppToRegistryInfo(app: OverlayApp): RegistryAppInfo {
  return {
    name: app.name,
    displayName: app.displayName,
    description: app.description,
    category: app.category,
    launchType: "overlay",
    launchUrl: null,
    icon: app.icon,
    heroImage: app.heroImage ?? null,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: app.name,
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
  };
}

// ---------------------------------------------------------------------------
// App detail-extension registry.
// ---------------------------------------------------------------------------

/**
 * Registry of app detail extension components keyed by the app's
 * `uiExtension.detailPanelId` string.
 *
 * Apps register their detail extension on startup via side-effect import.
 */
const DETAIL_EXTENSION_COMPONENTS = new Map<
  string,
  AppDetailExtensionComponent
>();

/**
 * Register a detail-panel extension component for a given panel id.
 * Call this once per app at module load time (e.g. from the app's UI entry).
 *
 * @example
 *   registerDetailExtension("example-detail-panel", ExampleDetailExtension);
 */
export function registerDetailExtension(
  detailPanelId: string,
  component: AppDetailExtensionComponent,
): void {
  DETAIL_EXTENSION_COMPONENTS.set(detailPanelId, component);
}

export function getAppDetailExtension(
  app: RegistryAppInfo,
): AppDetailExtensionComponent | null {
  const detailPanelId = app.uiExtension?.detailPanelId;
  if (!detailPanelId) return null;
  return DETAIL_EXTENSION_COMPONENTS.get(detailPanelId) ?? null;
}
