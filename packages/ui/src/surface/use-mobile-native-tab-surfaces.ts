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
 * WebView, so React chrome is mirrored into rounded native occlusion regions;
 * the page stays full-size and live while the host paints and handles input in
 * those holes, matching Electrobun's masks mechanism. Whole-surface overlays
 * (the tab switcher and confirmation dialogs) still background every surface.
 * (2) The layer and its occlusions use host CSS pixels and are re-measured on
 * layout, viewport, and chat-motion changes so neither can drift from React.
 */

import type { SurfaceLifecyclePolicy } from "@elizaos/core";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { CapacitorNativeSurfaceShell } from "./capacitor-native-surface-shell";
import type {
  NativeSurfacePolicy,
  NativeSurfaceShell,
  SurfaceBounds,
  SurfaceCornerRadii,
  SurfaceOcclusionRect,
  SurfaceOuterClip,
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
   * Host elements that must paint and receive input above the native page. Their
   * live rounded bounds become native occlusion holes.
   */
  readonly occlusionSelector?: string;
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

function roundedCssPixel(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseCornerRadius(value: string): number {
  const radius = Number.parseFloat(value);
  return Number.isFinite(radius) && radius > 0 ? roundedCssPixel(radius) : 0;
}

const ZERO_CORNER_RADII: SurfaceCornerRadii = {
  topLeft: 0,
  topRight: 0,
  bottomRight: 0,
  bottomLeft: 0,
};

function rectHasArea(rect: DOMRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function roundedRect(rect: DOMRect): Omit<SurfaceBounds, "outerClip"> {
  return {
    x: roundedCssPixel(rect.left),
    y: roundedCssPixel(rect.top),
    width: roundedCssPixel(rect.width),
    height: roundedCssPixel(rect.height),
  };
}

function readCornerRadii(style: CSSStyleDeclaration): SurfaceCornerRadii {
  const shorthand = parseCornerRadius(style.borderRadius);
  return {
    topLeft: parseCornerRadius(style.borderTopLeftRadius) || shorthand,
    topRight: parseCornerRadius(style.borderTopRightRadius) || shorthand,
    bottomRight: parseCornerRadius(style.borderBottomRightRadius) || shorthand,
    bottomLeft: parseCornerRadius(style.borderBottomLeftRadius) || shorthand,
  };
}

function hasRoundedCorner(radii: SurfaceCornerRadii): boolean {
  return Object.values(radii).some((radius) => radius > 0);
}

function clipsDescendants(style: CSSStyleDeclaration): boolean {
  return [style.overflow, style.overflowX, style.overflowY].some(
    (value) => value === "hidden" || value === "clip",
  );
}

function findRoundedClipHost(element: HTMLElement): HTMLElement | null {
  const view = element.ownerDocument.defaultView;
  if (!view) return null;
  for (
    let candidate: HTMLElement | null = element;
    candidate;
    candidate = candidate.parentElement
  ) {
    const style = view.getComputedStyle(candidate);
    if (clipsDescendants(style) && hasRoundedCorner(readCornerRadii(style))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolves the real rounded React clip enclosing a native page. The search is
 * structural: it follows the DOM to the nearest rounded overflow clip and reads
 * computed pixels, so the native contract never duplicates a Tailwind token or
 * assumes the host and page placeholder share an element.
 */
export function collectSurfaceOuterClip(
  element: HTMLElement,
): SurfaceOuterClip {
  const surfaceRect = element.getBoundingClientRect();
  const host = findRoundedClipHost(element);
  if (!host) {
    return { ...roundedRect(surfaceRect), cornerRadii: ZERO_CORNER_RADII };
  }
  const hostRect = host.getBoundingClientRect();
  if (!rectHasArea(hostRect)) {
    return { ...roundedRect(surfaceRect), cornerRadii: ZERO_CORNER_RADII };
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle(host);
  return {
    ...roundedRect(hostRect),
    cornerRadii: style ? readCornerRadii(style) : ZERO_CORNER_RADII,
  };
}

/**
 * Reads the visible rounded geometry for native-layer occlusion. Kept pure over
 * the supplied document so the exact DOM→native contract is regression-tested.
 */
export function collectSurfaceOcclusionRects(
  selector: string | undefined,
  ownerDocument: Document,
): SurfaceOcclusionRect[] {
  if (!selector) return [];
  const rects: SurfaceOcclusionRect[] = [];
  const seen = new Set<Element>();
  for (const element of ownerDocument.querySelectorAll<HTMLElement>(selector)) {
    if (seen.has(element)) continue;
    seen.add(element);
    const style = ownerDocument.defaultView?.getComputedStyle(element);
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse"
    ) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (!rectHasArea(rect)) {
      continue;
    }
    rects.push({
      x: roundedCssPixel(rect.left),
      y: roundedCssPixel(rect.top),
      width: roundedCssPixel(rect.width),
      height: roundedCssPixel(rect.height),
      cornerRadius: parseCornerRadius(
        element.style.borderTopLeftRadius ||
          element.style.borderRadius ||
          style?.borderTopLeftRadius ||
          style?.borderRadius ||
          "0",
      ),
    });
  }
  // A native mask represents the union of these regions. Nested portal/status
  // chrome is already covered by its outer sheet; dropping contained geometry
  // prevents even-odd native masks from toggling those pixels back on.
  return rects
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .reduce<SurfaceOcclusionRect[]>((outer, rect) => {
      const contained = outer.some(
        (candidate) =>
          rect.x >= candidate.x &&
          rect.y >= candidate.y &&
          rect.x + rect.width <= candidate.x + candidate.width &&
          rect.y + rect.height <= candidate.y + candidate.height,
      );
      if (!contained) outer.push(rect);
      return outer;
    }, []);
}

export function useMobileNativeTabSurfaces(
  args: UseMobileNativeTabSurfacesArgs,
): MobileNativeTabSurfaces {
  const {
    active,
    tabs,
    selectedTabId,
    overlayOpen,
    occlusionSelector,
    policy,
    lifecycle,
    shell,
  } = args;

  // One shell per hosting Browser view. A caller-supplied shell (tests) wins;
  // otherwise the Capacitor driver, constructed once.
  const defaultShell = useMemo(() => new CapacitorNativeSurfaceShell(), []);
  const activeShell = shell ?? defaultShell;

  const elements = useRef(new Map<string, HTMLElement>());
  // The tab ids this hook has handed to the shell. Native acceptance is tracked
  // by the shell itself; this desired-set may include a create still in flight so
  // initial bounds/holes can queue behind that acknowledged create.
  const managedTabIds = useRef(new Set<string>());
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
      const id = surfaceIdOf(tabId);
      if (!element || !managedTabIds.current.has(tabId)) return;
      const rect = element.getBoundingClientRect();
      if (!rectHasArea(rect)) return;
      const bounds: SurfaceBounds = {
        ...roundedRect(rect),
        outerClip: collectSurfaceOuterClip(element),
      };
      activeShell.setBounds(id, bounds);
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

  const readOcclusions = useCallback(
    (): SurfaceOcclusionRect[] =>
      typeof document === "undefined"
        ? []
        : collectSurfaceOcclusionRects(occlusionSelector, document),
    [occlusionSelector],
  );

  const syncOcclusions = useCallback((): void => {
    const rects = readOcclusions();
    for (const tabId of managedTabIds.current) {
      activeShell.setOcclusionRects(surfaceIdOf(tabId), rects);
    }
  }, [activeShell, readOcclusions]);

  // Reconcile the live surface set with `tabs`: create surfaces for new tabs
  // (explicit policy, never a default), navigate on an existing tab's URL change,
  // destroy surfaces for closed tabs.
  useEffect(() => {
    if (!active) return;
    const wanted = new Set(tabs.map((tab) => tab.id));
    for (const tab of tabs) {
      const id = surfaceIdOf(tab.id);
      if (!managedTabIds.current.has(tab.id)) {
        activeShell.createSurface({ id, url: tab.url, policy });
        managedTabIds.current.add(tab.id);
        surfaceUrls.current.set(tab.id, tab.url);
        measure(tab.id);
        activeShell.setOcclusionRects(id, readOcclusions());
      } else if (surfaceUrls.current.get(tab.id) !== tab.url) {
        activeShell.navigate(id, tab.url);
        surfaceUrls.current.set(tab.id, tab.url);
      }
    }
    for (const tabId of [...managedTabIds.current]) {
      if (!wanted.has(tabId)) {
        activeShell.destroySurface(surfaceIdOf(tabId));
        managedTabIds.current.delete(tabId);
        surfaceUrls.current.delete(tabId);
        elements.current.delete(tabId);
      }
    }
  }, [active, tabs, policy, activeShell, measure, readOcclusions]);

  // Keep React-chrome holes aligned. ResizeObserver catches layout changes;
  // MutationObserver catches portals and Motion style writes. During a chat
  // spring/drag, its canonical transient-layout marker keeps one rAF loop alive
  // so transform-only frames cannot slip between discrete DOM mutations.
  useEffect(() => {
    if (
      !active ||
      !occlusionSelector ||
      typeof document === "undefined" ||
      typeof window === "undefined"
    ) {
      return;
    }
    let frame: number | null = null;
    let observed = new Set<Element>();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => schedule());

    const refreshObservedElements = (): void => {
      if (!resizeObserver) return;
      const next = new Set(document.querySelectorAll(occlusionSelector));
      for (const element of observed) {
        if (!next.has(element)) resizeObserver.unobserve(element);
      }
      for (const element of next) {
        if (!observed.has(element)) resizeObserver.observe(element);
      }
      observed = next;
    };
    const run = (): void => {
      frame = null;
      syncOcclusions();
      if (
        document.querySelector('[data-eliza-layout-shift-intent="transient"]')
      ) {
        schedule();
      }
    };
    const schedule = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(run);
    };

    refreshObservedElements();
    syncOcclusions();
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            refreshObservedElements();
            schedule();
          });
    mutationObserver?.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "data-chat-state",
        "data-eliza-layout-shift-intent",
      ],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.addEventListener("scroll", schedule, true);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("scroll", schedule, true);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [active, occlusionSelector, syncOcclusions]);

  // Page placement and the rounded host clip have a separate observer from the
  // chat-hole animation loop. The shell sequences these writes behind creation
  // and deduplicates only after native acceptance; keeping measurement free of
  // pre-ack caches means a rejected write remains retryable.
  useEffect(() => {
    if (
      !active ||
      typeof document === "undefined" ||
      typeof window === "undefined"
    ) {
      return;
    }
    let frame: number | null = null;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => schedule());
    const attributeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            refreshObservedGeometry();
            schedule();
          });

    const measureAll = (): void => {
      frame = null;
      for (const tabId of elements.current.keys()) measure(tabId);
    };
    const schedule = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(measureAll);
    };
    const refreshObservedGeometry = (): void => {
      resizeObserver?.disconnect();
      attributeObserver?.disconnect();
      const resizeTargets = new Set<HTMLElement>();
      const attributeTargets = new Set<HTMLElement>();
      for (const element of elements.current.values()) {
        resizeTargets.add(element);
        const clipHost = findRoundedClipHost(element);
        if (clipHost) resizeTargets.add(clipHost);
        for (
          let ancestor: HTMLElement | null = element;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          attributeTargets.add(ancestor);
        }
      }
      for (const target of resizeTargets) resizeObserver?.observe(target);
      for (const target of attributeTargets) {
        attributeObserver?.observe(target, {
          attributes: true,
          attributeFilter: ["class", "style", "hidden"],
        });
      }
    };
    const treeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            refreshObservedGeometry();
            schedule();
          });

    refreshObservedGeometry();
    schedule();
    treeObserver?.observe(document.documentElement, {
      subtree: true,
      childList: true,
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.addEventListener("scroll", schedule, true);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      treeObserver?.disconnect();
      attributeObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("scroll", schedule, true);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [active, measure]);

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

  // On unmount, apply the manifest lifecycle: `retained` keeps surfaces warm in
  // the background; `ephemeral` (the Browser default) tears them down.
  useEffect(() => {
    const managed = managedTabIds.current;
    return () => {
      for (const tabId of managed) {
        const id = surfaceIdOf(tabId);
        if (lifecycleRef.current === "retained") {
          activeShell.backgroundSurface(id);
        } else {
          activeShell.destroySurface(id);
        }
      }
      managed.clear();
    };
    // Cleanup must run only on unmount; it reads the shell + lifecycle via refs.
  }, [activeShell]);

  return { registerSurfaceElement, navigateSurface };
}
