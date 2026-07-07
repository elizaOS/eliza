/**
 * React hook that layers one isolated native web surface per Browser tab on the
 * mobile shell (#15245). It is the live consumer of the native-surface seam:
 * `BrowserWorkspaceView` mounts it on the `native-mobile-webview` render path
 * (chosen by `resolveBrowserTabRenderPath` when the Browser view's
 * `native-webview` isolation meets a native mobile host), reserving an
 * absolutely-positioned placeholder `<div>` per tab that this hook tracks and
 * overlays with a real `WKWebView` / Android `WebView` through the
 * {@link NativeSurfaceShell}.
 *
 * Why a hook driving native layers instead of iframes: on the web the Browser
 * view falls back to a sandboxed iframe, but a mobile in-realm iframe still
 * shares the host WebView's renderer process and storage partition — the exact
 * cross-surface leak the isolation epic closes. The native surface runs the
 * page in its own process + data store (the explicit {@link NativeSurfacePolicy}
 * derived from the manifest, passed through verbatim), so nothing a page writes
 * is reachable from the host or a sibling tab.
 *
 * Two constraints shape the effects. (1) Native layers z-order ABOVE the host
 * WebView, so while any React overlay is open (`overlayOpen` — the tab switcher,
 * a confirm dialog) every surface is backgrounded, or it would paint over the
 * overlay; this is the mobile equivalent of the desktop `<electrobun-webview
 * masks=…>` mechanism. (2) The layer is positioned in host CSS pixels from the
 * placeholder rect, re-measured on every layout shift (resize, orientation,
 * visual-viewport scroll from the keyboard) so it never drifts off its slot.
 */

import type { SurfaceLifecyclePolicy } from "@elizaos/core";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { CapacitorNativeSurfaceShell } from "./capacitor-native-surface-shell";
import type {
  NativeSurfacePolicy,
  NativeSurfaceShell,
} from "./native-surface-shell";

/** The minimal per-tab shape the hook needs: identity plus the page to load. */
export interface MobileNativeSurfaceTab {
  readonly id: string;
  readonly url: string;
}

export interface UseMobileNativeTabSurfacesArgs {
  /**
   * Whether the `native-mobile-webview` render path is active. When false the
   * hook is inert (no surfaces created) — the Browser view is rendering iframes
   * or the desktop OOPIF instead.
   */
  readonly active: boolean;
  /** The open Browser tabs, in order. The live surface set mirrors this exactly. */
  readonly tabs: readonly MobileNativeSurfaceTab[];
  /** The foregrounded tab id, or null when none is selected. */
  readonly selectedTabId: string | null;
  /**
   * Whether a React overlay (tab switcher, confirm dialog) is open. While true
   * every native surface is backgrounded so it cannot paint over the overlay.
   */
  readonly overlayOpen: boolean;
  /**
   * The explicit process/storage policy every surface is created with — derived
   * from the Browser manifest via `deriveSurfacePlacement`, never defaulted here.
   */
  readonly policy: NativeSurfacePolicy;
  /**
   * Retention when the Browser view unmounts: `retained` keeps surfaces warm in
   * the background, `ephemeral` destroys them. Read from the manifest lifecycle
   * so flipping the manifest changes teardown with no code change here.
   */
  readonly lifecycle: SurfaceLifecyclePolicy;
  /**
   * Injectable shell. Production passes nothing and gets the Capacitor driver;
   * tests pass a faithful in-memory shell to assert the exact command sequence.
   */
  readonly shell?: NativeSurfaceShell;
}

/** The imperative handles the Browser view binds to per-tab DOM + navigation. */
export interface MobileNativeTabSurfaces {
  /**
   * Ref callback for a tab's placeholder `<div>`. Registering an element starts
   * bounds tracking for that tab; passing null (on unmount) stops it.
   */
  registerSurfaceElement(tabId: string, element: HTMLElement | null): void;
  /** Load a URL in a tab's native surface (address-bar navigation). */
  navigateSurface(tabId: string, url: string): void;
}

/**
 * Namespacing the shell id keeps Browser-tab surfaces from colliding with any
 * other native surface the app may layer in future; the tab id alone is not a
 * guaranteed-unique key across surface owners.
 */
function surfaceIdOf(tabId: string): string {
  return `browser-tab:${tabId}`;
}

export function useMobileNativeTabSurfaces(
  args: UseMobileNativeTabSurfacesArgs,
): MobileNativeTabSurfaces {
  const { active, tabs, selectedTabId, overlayOpen, policy, lifecycle, shell } =
    args;

  // One shell per hosting Browser view. A caller-supplied shell (tests) wins;
  // otherwise the Capacitor driver, constructed once.
  const defaultShell = useMemo(() => new CapacitorNativeSurfaceShell(), []);
  const activeShell = shell ?? defaultShell;

  const elements = useRef(new Map<string, HTMLElement>());
  // The tab ids that currently own a live native surface. Tracked here, not read
  // off `elements`, because a closed tab's placeholder `<div>` unregisters
  // (child cleanup runs before this hook's own) before the surface is torn down.
  const liveTabIds = useRef(new Set<string>());
  // Last URL loaded into each surface, so a change to a tab's `url` (address-bar
  // navigation upstream) drives a `navigate` instead of a spurious re-create.
  const surfaceUrls = useRef(new Map<string, string>());
  // Latest lifecycle for the unmount cleanup, which runs with an empty dep list
  // and would otherwise close over a stale value.
  const lifecycleRef = useRef(lifecycle);
  lifecycleRef.current = lifecycle;

  const measure = useCallback(
    (tabId: string): void => {
      const element = elements.current.get(tabId);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      activeShell.setBounds(surfaceIdOf(tabId), {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    },
    [activeShell],
  );

  const registerSurfaceElement = useCallback(
    (tabId: string, element: HTMLElement | null): void => {
      if (element) {
        elements.current.set(tabId, element);
        if (active) measure(tabId);
      } else {
        elements.current.delete(tabId);
      }
    },
    [active, measure],
  );

  const navigateSurface = useCallback(
    (tabId: string, url: string): void => {
      if (!active) return;
      activeShell.navigate(surfaceIdOf(tabId), url);
    },
    [active, activeShell],
  );

  // Reconcile the live surface set with `tabs`: create surfaces for new tabs
  // (explicit policy, never a default), navigate on an existing tab's URL change,
  // destroy surfaces for closed tabs.
  useEffect(() => {
    if (!active) return;
    const wanted = new Set(tabs.map((tab) => tab.id));
    for (const tab of tabs) {
      const id = surfaceIdOf(tab.id);
      if (!liveTabIds.current.has(tab.id)) {
        activeShell.createSurface({ id, url: tab.url, policy });
        liveTabIds.current.add(tab.id);
        surfaceUrls.current.set(tab.id, tab.url);
        measure(tab.id);
      } else if (surfaceUrls.current.get(tab.id) !== tab.url) {
        activeShell.navigate(id, tab.url);
        surfaceUrls.current.set(tab.id, tab.url);
      }
    }
    for (const tabId of [...liveTabIds.current]) {
      if (!wanted.has(tabId)) {
        activeShell.destroySurface(surfaceIdOf(tabId));
        liveTabIds.current.delete(tabId);
        surfaceUrls.current.delete(tabId);
        elements.current.delete(tabId);
      }
    }
  }, [active, tabs, policy, activeShell, measure]);

  // Foreground the selected surface and background the rest — unless an overlay
  // is open, in which case every surface is backgrounded (see header).
  useEffect(() => {
    if (!active) return;
    for (const tab of tabs) {
      const id = surfaceIdOf(tab.id);
      if (!overlayOpen && tab.id === selectedTabId) {
        activeShell.foregroundSurface(id);
        measure(tab.id);
      } else {
        activeShell.backgroundSurface(id);
      }
    }
  }, [active, tabs, selectedTabId, overlayOpen, activeShell, measure]);

  // Track the placeholder rects across every layout shift so the native layer
  // never drifts off its slot: window resize, device rotation, and the
  // visual-viewport changes the on-screen keyboard drives.
  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const measureAll = () => {
      for (const [tabId] of elements.current) measure(tabId);
    };
    window.addEventListener("resize", measureAll);
    window.addEventListener("orientationchange", measureAll);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", measureAll);
    viewport?.addEventListener("scroll", measureAll);
    return () => {
      window.removeEventListener("resize", measureAll);
      window.removeEventListener("orientationchange", measureAll);
      viewport?.removeEventListener("resize", measureAll);
      viewport?.removeEventListener("scroll", measureAll);
    };
  }, [active, measure]);

  // On unmount, apply the manifest lifecycle: `retained` keeps surfaces warm in
  // the background; `ephemeral` (the Browser default) tears them down.
  useEffect(() => {
    const live = liveTabIds.current;
    return () => {
      for (const tabId of live) {
        const id = surfaceIdOf(tabId);
        if (lifecycleRef.current === "retained") {
          activeShell.backgroundSurface(id);
        } else {
          activeShell.destroySurface(id);
        }
      }
      live.clear();
    };
    // Cleanup must run only on unmount; it reads the shell + lifecycle via refs.
  }, [activeShell]);

  return { registerSurfaceElement, navigateSurface };
}
