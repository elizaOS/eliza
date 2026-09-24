/**
 * Overlay App API — contract for full-screen overlay applications.
 *
 * Any app that renders as a full-screen overlay (like the VRM companion)
 * implements this interface. The host shell renders the active overlay's
 * Component and manages lifecycle hooks.
 *
 * The React type references below are erased at compile time — this module
 * carries no runtime dependency on the React package, which is why it lives in
 * `@elizaos/shared` (consumed by both the React `@elizaos/ui` package and Node
 * app-registration code).
 */

import type { ComponentType, ReactElement } from "react";

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
   * The platform check is performed by `getAvailableOverlayApps()` in
   * `overlay-app-registry.ts`; the registry itself accepts any platform's
   * registrations so server-side rendering and tests don't have to mock
   * Capacitor.
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
