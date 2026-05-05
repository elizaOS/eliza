/**
 * useCanvasWindow
 *
 * Creates a floating BrowserWindow (via the Electrobun canvas RPC) that is
 * positioned and sized to match a DOM placeholder div.  The BrowserWindow
 * appears to be "embedded" because it is always kept aligned with the div.
 *
 * Works in:
 *   - Electrobun — calls via the preload-exposed renderer RPC
 *   - Legacy desktop bridge compatibility — falls back to the historical bridge
 *
 * Falls back gracefully (isReady=false, no window created) when neither
 * runtime is detected (web / Capacitor / SSR).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invokeDesktopBridgeRequest } from "../bridge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseCanvasWindowOptions {
  /** URL to load inside the floating BrowserWindow. */
  url: string;
  /** When false the window is not created (and any existing one is destroyed). */
  enabled: boolean;
  /** Window title passed to canvasCreateWindow. */
  title?: string;
}

export interface UseCanvasWindowResult {
  /** Attach to the placeholder <div> that the BrowserWindow should cover. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** The canvas window ID returned by canvasCreateWindow, or null before ready. */
  windowId: string | null;
  /** True once the window has been created and positioned. */
  isReady: boolean;
  /** Navigate the canvas window to a new URL. */
  navigate: (url: string) => void;
  /** Show the canvas window (if it was hidden). */
  show: () => void;
  /** Hide the canvas window. */
  hide: () => void;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function getScreenRect(el: HTMLElement): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.left + window.scrollX),
    y: Math.round(rect.top + window.scrollY),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCanvasWindow(
  options: UseCanvasWindowOptions,
): UseCanvasWindowResult {
  const { url, enabled, title } = options;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const windowIdRef = useRef<string | null>(null);
  const [windowId, setWindowId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);

  // Stable refs so callbacks don't need to re-bind.
  const urlRef = useRef(url);
  urlRef.current = url;
  const titleRef = useRef(title);
  titleRef.current = title;

  // Track last-synced bounds to avoid redundant bridge calls.
  const lastBoundsRef = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  const syncFrameRef = useRef<number | null>(null);
  const trackingFrameRef = useRef<number | null>(null);
  const animationTrackerCountRef = useRef(0);

  // ---------------------------------------------------------------------------
  // Sync position/size to the placeholder div
  // ---------------------------------------------------------------------------

  const syncBounds = useCallback(() => {
    const el = containerRef.current;
    const id = windowIdRef.current;
    if (!el || !id) return;

    const bounds = getScreenRect(el);

    const last = lastBoundsRef.current;
    if (
      last &&
      last.x === bounds.x &&
      last.y === bounds.y &&
      last.width === bounds.width &&
      last.height === bounds.height
    ) {
      return; // Nothing changed — skip the bridge call.
    }

    lastBoundsRef.current = bounds;

    void invokeDesktopBridgeRequest({
      rpcMethod: "canvasSetBounds",
      ipcChannel: "canvas:setBounds",
      params: { id, ...bounds },
    }).catch((err: unknown) => {
      console.warn("[useCanvasWindow] canvas:setBounds failed", err);
    });
  }, []);

  const scheduleSyncBounds = useCallback(() => {
    if (trackingFrameRef.current !== null || syncFrameRef.current !== null) {
      return;
    }
    syncFrameRef.current = requestAnimationFrame(() => {
      syncFrameRef.current = null;
      syncBounds();
    });
  }, [syncBounds]);

  const startTrackingBounds = useCallback(() => {
    if (trackingFrameRef.current !== null) {
      return;
    }
    const loop = () => {
      syncBounds();
      trackingFrameRef.current = requestAnimationFrame(loop);
    };
    trackingFrameRef.current = requestAnimationFrame(loop);
  }, [syncBounds]);

  const stopTrackingBounds = useCallback(() => {
    if (trackingFrameRef.current !== null) {
      cancelAnimationFrame(trackingFrameRef.current);
      trackingFrameRef.current = null;
    }
    if (syncFrameRef.current !== null) {
      cancelAnimationFrame(syncFrameRef.current);
      syncFrameRef.current = null;
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Lifecycle: create / destroy window
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!enabled) return;

    let destroyed = false;
    let createdId: string | null = null;

    // Determine initial position from the container div (if already mounted).
    const el = containerRef.current;
    const initial = el
      ? getScreenRect(el)
      : { x: 100, y: 100, width: 800, height: 600 };

    void invokeDesktopBridgeRequest<{ id?: string }>({
      rpcMethod: "canvasCreateWindow",
      ipcChannel: "canvas:createWindow",
      params: {
        url: urlRef.current,
        title: titleRef.current ?? "Canvas",
        x: initial.x,
        y: initial.y,
        width: initial.width,
        height: initial.height,
      },
    })
      .then((result) => {
        if (!result) {
          return;
        }
        if (destroyed) {
          // Component unmounted before the promise resolved — clean up.
          const id = result.id;
          if (id) {
            void invokeDesktopBridgeRequest({
              rpcMethod: "canvasDestroyWindow",
              ipcChannel: "canvas:destroyWindow",
              params: { id },
            }).catch((err: unknown) => {
              console.warn(
                "[useCanvasWindow] canvas:destroyWindow cleanup failed",
                err,
              );
            });
          }
          return;
        }

        const id = result.id;
        if (!id) {
          console.warn("[useCanvasWindow] canvasCreateWindow returned no id");
          return;
        }

        createdId = id;
        windowIdRef.current = id;
        setWindowId(id);
        lastBoundsRef.current = null; // Force a setBounds on next sync.
        setIsReady(true);
        scheduleSyncBounds();
      })
      .catch((err: unknown) => {
        console.warn("[useCanvasWindow] canvas:createWindow failed", err);
      });

    const isTrackedTarget = (target: EventTarget | null) => {
      const trackedElement = containerRef.current;
      return (
        trackedElement !== null &&
        target instanceof Node &&
        trackedElement.contains(target)
      );
    };
    const handleViewportChange = () => {
      scheduleSyncBounds();
    };
    const startAnimationTracking = (event: Event) => {
      if (!isTrackedTarget(event.target)) {
        return;
      }
      animationTrackerCountRef.current += 1;
      startTrackingBounds();
    };
    const stopAnimationTracking = (event: Event) => {
      if (!isTrackedTarget(event.target)) {
        return;
      }
      animationTrackerCountRef.current = Math.max(
        0,
        animationTrackerCountRef.current - 1,
      );
      if (animationTrackerCountRef.current === 0) {
        stopTrackingBounds();
        scheduleSyncBounds();
      }
    };

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("transitionstart", startAnimationTracking, true);
    window.addEventListener("transitionend", stopAnimationTracking, true);
    window.addEventListener("transitioncancel", stopAnimationTracking, true);
    window.addEventListener("animationstart", startAnimationTracking, true);
    window.addEventListener("animationend", stopAnimationTracking, true);
    window.addEventListener("animationcancel", stopAnimationTracking, true);
    window.visualViewport?.addEventListener("resize", handleViewportChange);
    window.visualViewport?.addEventListener("scroll", handleViewportChange);

    // ResizeObserver: pick up size changes from layout shifts.
    let ro: ResizeObserver | null = null;
    if (el && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        scheduleSyncBounds();
      });
      ro.observe(el);
    }

    return () => {
      destroyed = true;
      animationTrackerCountRef.current = 0;
      stopTrackingBounds();
      ro?.disconnect();
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener(
        "transitionstart",
        startAnimationTracking,
        true,
      );
      window.removeEventListener("transitionend", stopAnimationTracking, true);
      window.removeEventListener(
        "transitioncancel",
        stopAnimationTracking,
        true,
      );
      window.removeEventListener(
        "animationstart",
        startAnimationTracking,
        true,
      );
      window.removeEventListener("animationend", stopAnimationTracking, true);
      window.removeEventListener(
        "animationcancel",
        stopAnimationTracking,
        true,
      );
      window.visualViewport?.removeEventListener(
        "resize",
        handleViewportChange,
      );
      window.visualViewport?.removeEventListener(
        "scroll",
        handleViewportChange,
      );

      const id = createdId ?? windowIdRef.current;
      if (id) {
        windowIdRef.current = null;
        setWindowId(null);
        setIsReady(false);
        lastBoundsRef.current = null;
        void invokeDesktopBridgeRequest({
          rpcMethod: "canvasDestroyWindow",
          ipcChannel: "canvas:destroyWindow",
          params: { id },
        }).catch((err: unknown) => {
          console.warn(
            "[useCanvasWindow] canvas:destroyWindow teardown failed",
            err,
          );
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, scheduleSyncBounds, startTrackingBounds, stopTrackingBounds]);

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const navigate = useCallback((newUrl: string) => {
    const id = windowIdRef.current;
    if (!id) return;
    void invokeDesktopBridgeRequest({
      rpcMethod: "canvasNavigate",
      ipcChannel: "canvas:navigate",
      params: { id, url: newUrl },
    }).catch((err: unknown) => {
      console.warn("[useCanvasWindow] canvas:navigate failed", err);
    });
  }, []);

  const show = useCallback(() => {
    const id = windowIdRef.current;
    if (!id) return;
    void invokeDesktopBridgeRequest({
      rpcMethod: "canvasShow",
      ipcChannel: "canvas:show",
      params: { id },
    }).catch((err: unknown) => {
      console.warn("[useCanvasWindow] canvas:show failed", err);
    });
  }, []);

  const hide = useCallback(() => {
    const id = windowIdRef.current;
    if (!id) return;
    void invokeDesktopBridgeRequest({
      rpcMethod: "canvasHide",
      ipcChannel: "canvas:hide",
      params: { id },
    }).catch((err: unknown) => {
      console.warn("[useCanvasWindow] canvas:hide failed", err);
    });
  }, []);

  return { containerRef, windowId, isReady, navigate, show, hide };
}
