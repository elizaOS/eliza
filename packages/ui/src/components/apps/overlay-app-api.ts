/**
 * Overlay App API — contract for full-screen overlay applications.
 *
 * Any app that renders as a full-screen overlay (like the VRM companion)
 * implements this interface. The host shell renders the active overlay's
 * Component and manages lifecycle hooks.
 */

import type { ReactElement } from "react";

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
  /** Unique app identifier (npm-style, e.g. "@elizaos/app-companion"). */
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
   */
  readonly Component: (props: OverlayAppContext) => ReactElement;
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
