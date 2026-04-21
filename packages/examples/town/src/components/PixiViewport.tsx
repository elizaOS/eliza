import { extend, useApplication } from "@pixi/react";
import { type IViewportOptions, Viewport } from "pixi-viewport";
import type { MutableRefObject, ReactNode } from "react";
import { createElement, useCallback, useEffect, useMemo, useRef } from "react";

// Register Viewport with @pixi/react
extend({ Viewport });

// Type for the pixiViewport JSX element
type PixiViewportProps = IViewportOptions & {
  ref?: React.Ref<Viewport>;
  children?: ReactNode;
};

// Helper to create the pixiViewport element with proper typing
function createPixiViewport(props: PixiViewportProps) {
  return createElement("pixiViewport" as unknown as string, props);
}

export type ViewportProps = {
  viewportRef?: MutableRefObject<Viewport | undefined>;
  screenWidth: number;
  screenHeight: number;
  worldWidth: number;
  worldHeight: number;
  onUserInteract?: () => void;
  children?: ReactNode;
};

type ViewportWithWheel = Viewport & {
  __wheelListener?: (event: WheelEvent) => void;
  __wheelView?: HTMLCanvasElement;
  __userInteract?: () => void;
  __userInteractListener?: () => void;
  __didInit?: boolean;
};

type ScaleBounds = {
  minScale: number;
  maxScale: number;
};

export default function PixiViewport({
  viewportRef,
  screenWidth,
  screenHeight,
  worldWidth,
  worldHeight,
  onUserInteract,
  children,
}: ViewportProps) {
  const { app, isInitialised } = useApplication();
  const viewportInstance = useRef<ViewportWithWheel | null>(null);
  const scaleBoundsRef = useRef<ScaleBounds>({ minScale: 1, maxScale: 3 });
  const events = isInitialised && app ? (app.renderer?.events ?? null) : null;

  const setViewportRef = useCallback(
    (instance: Viewport | null) => {
      viewportInstance.current = instance as ViewportWithWheel | null;
      if (viewportRef) {
        viewportRef.current = instance ?? undefined;
      }
    },
    [viewportRef],
  );

  const viewportOptions = useMemo<IViewportOptions | null>(() => {
    if (!events) {
      return null;
    }
    return {
      screenWidth,
      screenHeight,
      worldWidth,
      worldHeight,
      passiveWheel: false,
      events,
    };
  }, [events, screenWidth, screenHeight, worldWidth, worldHeight]);

  useEffect(() => {
    if (!isInitialised) {
      return;
    }
    const viewport = viewportInstance.current;
    if (!viewport) {
      return;
    }

    if (
      !viewport.__didInit &&
      screenWidth > 0 &&
      screenHeight > 0 &&
      worldWidth > 0 &&
      worldHeight > 0
    ) {
      viewport.__didInit = true;
      // fitScale = scale at which world exactly fills screen
      const fitScale = Math.max(
        screenWidth / worldWidth,
        screenHeight / worldHeight,
      );
      // minScale = 15% larger than fit, so there's always room to pan around
      const minScale = fitScale * 1.15;
      const maxScale = 3;
      scaleBoundsRef.current = { minScale, maxScale };

      viewport
        .drag()
        .pinch({})
        .decelerate()
        .clampZoom({ minScale, maxScale })
        .clamp({ direction: "all", underflow: "center" })
        .setZoom(minScale, true);
      viewport.moveCenter(worldWidth / 2, worldHeight / 2);
    }

    viewport.__userInteract = onUserInteract;
    if (!app) {
      return;
    }
    const view = app.canvas as HTMLCanvasElement;
    const handleInteract = () => {
      viewport.__userInteract?.();
    };
    const handleWheel = (event: WheelEvent) => {
      // Always prevent default to stop trackpad scroll from panning the page
      event.preventDefault();
      event.stopPropagation();

      // Only zoom on vertical scroll (deltaY), ignore horizontal scroll (deltaX)
      // This prevents trackpad two-finger swipes from both zooming and scrolling
      if (event.deltaY === 0) {
        return;
      }

      viewport.__userInteract?.();
      const { minScale, maxScale } = scaleBoundsRef.current;
      // Use ctrlKey check to detect pinch-to-zoom gesture on trackpad
      // Pinch gestures typically have ctrlKey set and larger deltaY values
      const isPinchGesture = event.ctrlKey;
      const zoomMultiplier = isPinchGesture
        ? event.deltaY < 0
          ? 1.05
          : 0.95 // Finer control for pinch
        : event.deltaY < 0
          ? 1.1
          : 0.9; // Standard scroll wheel
      const nextScale = viewport.scale.x * zoomMultiplier;
      const clampedScale = Math.min(Math.max(nextScale, minScale), maxScale);
      viewport.setZoom(clampedScale, true);
      viewport.clamp({ direction: "all", underflow: "center" });
    };

    view.addEventListener("wheel", handleWheel, { passive: false });
    viewport.on("drag-start", handleInteract);
    viewport.on("pinch-start", handleInteract);
    viewport.__wheelListener = handleWheel;
    viewport.__wheelView = view;
    viewport.__userInteractListener = handleInteract;

    return () => {
      view.removeEventListener("wheel", handleWheel);
      viewport.off("drag-start", handleInteract);
      viewport.off("pinch-start", handleInteract);
    };
  }, [
    app,
    isInitialised,
    onUserInteract,
    screenWidth,
    screenHeight,
    worldHeight,
    worldWidth,
  ]);

  useEffect(() => {
    const viewport = viewportInstance.current;
    if (
      !viewport ||
      screenWidth <= 0 ||
      screenHeight <= 0 ||
      worldWidth <= 0 ||
      worldHeight <= 0
    ) {
      return;
    }
    viewport.screenWidth = screenWidth;
    viewport.screenHeight = screenHeight;
    viewport.worldWidth = worldWidth;
    viewport.worldHeight = worldHeight;

    // fitScale = scale at which world exactly fills screen
    const fitScale = Math.max(
      screenWidth / worldWidth,
      screenHeight / worldHeight,
    );
    // minScale = 15% larger than fit, so there's always room to pan around
    const minScale = fitScale * 1.15;
    const maxScale = 3;
    scaleBoundsRef.current = { minScale, maxScale };

    viewport.clampZoom({ minScale, maxScale });
    const currentScale = viewport.scale.x;
    if (currentScale < minScale) {
      viewport.setZoom(minScale, true);
    } else if (currentScale > maxScale) {
      viewport.setZoom(maxScale, true);
    }
    viewport.clamp({ direction: "all", underflow: "center" });
  }, [screenHeight, screenWidth, worldHeight, worldWidth]);

  if (!isInitialised || !events || !viewportOptions) {
    return null;
  }

  return createPixiViewport({
    ref: setViewportRef,
    ...viewportOptions,
    children,
  });
}
