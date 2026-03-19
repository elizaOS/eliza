import { useRenderGuard } from "@miladyai/app-core/hooks";
import {
  getVrmPreviewUrl,
  getVrmUrl,
  useApp,
  VRM_COUNT,
} from "@miladyai/app-core/state";
import { resolveAppAssetUrl } from "@miladyai/app-core/utils";
import {
  memo,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { VrmEngine } from "./avatar/VrmEngine";
import { SharedCompanionSceneContext } from "./shared-companion-scene-context";
import { VrmStage } from "./VrmStage";

const COMPANION_ZOOM_WHEEL_SENSITIVITY = 1 / 720;
const COMPANION_ZOOM_PINCH_SENSITIVITY = 2.35;
const COMPANION_ZOOM_STORAGE_KEY = "milady.companion.zoom.v1";
const DEFAULT_COMPANION_ZOOM = 0.95;
const CAMERA_DRAG_IGNORE_SELECTOR =
  'button, input, textarea, select, option, [role="button"], [role="listbox"], [aria-expanded], [aria-haspopup], [contenteditable="true"], [data-no-camera-drag="true"]';
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

// SharedCompanionSceneContext is imported from ./shared-companion-scene-context
// to keep the hook importable without pulling in the 3D stack.

type TouchPoint = {
  x: number;
  y: number;
};

function getTouchDistance(points: Map<number, TouchPoint>): number {
  const touchPoints = [...points.values()];
  if (touchPoints.length < 2) return 0;
  const [firstPoint, secondPoint] = touchPoints;
  if (!firstPoint || !secondPoint) return 0;
  return Math.hypot(secondPoint.x - firstPoint.x, secondPoint.y - firstPoint.y);
}

function getWheelPixels(event: ReactWheelEvent<HTMLDivElement>): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) {
    return event.deltaY * (window.innerHeight || 1);
  }
  return event.deltaY;
}

function hasFocusedTextEntry(): boolean {
  if (typeof document === "undefined") return false;
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLTextAreaElement) {
    return true;
  }
  if (activeElement instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(activeElement.type.toLowerCase());
  }
  return activeElement instanceof HTMLElement
    ? activeElement.isContentEditable
    : false;
}

function shouldIgnoreCameraDrag(target: EventTarget | null): boolean {
  return target instanceof Element
    ? Boolean(target.closest(CAMERA_DRAG_IGNORE_SELECTOR))
    : false;
}

function clampCompanionZoom(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function loadStoredCompanionZoom(): number {
  if (typeof localStorage === "undefined") return DEFAULT_COMPANION_ZOOM;
  try {
    const raw = localStorage.getItem(COMPANION_ZOOM_STORAGE_KEY);
    if (raw === null) return DEFAULT_COMPANION_ZOOM;
    const parsed = Number(raw);
    return Number.isFinite(parsed)
      ? clampCompanionZoom(parsed)
      : DEFAULT_COMPANION_ZOOM;
  } catch {
    return DEFAULT_COMPANION_ZOOM;
  }
}

function persistCompanionZoom(value: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      COMPANION_ZOOM_STORAGE_KEY,
      String(clampCompanionZoom(value)),
    );
  } catch {
    // Ignore persistence failures so camera controls remain responsive.
  }
}

function CompanionSceneSurface({
  active,
  interactive = true,
  children,
}: {
  active: boolean;
  interactive?: boolean;
  children?: ReactNode;
}) {
  useRenderGuard("CompanionSceneHost");
  const { selectedVrmIndex, customVrmUrl, uiTheme, t, tab } = useApp();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageEnginesRef = useRef(new Set<VrmEngine>());
  const companionZoomRef = useRef(DEFAULT_COMPANION_ZOOM);
  const companionZoomHydratedRef = useRef(false);
  const dragOrbitRef = useRef({ yaw: 0, pitch: 0 });
  const dragStateRef = useRef<{
    active: boolean;
    pointerId: number | null;
    startX: number;
    startY: number;
  }>({
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
  });
  const touchPointsRef = useRef(new Map<number, TouchPoint>());
  const pinchStateRef = useRef<{
    active: boolean;
    startDistance: number;
    startZoom: number;
  }>({
    active: false,
    startDistance: 0,
    startZoom: 0,
  });

  if (!companionZoomHydratedRef.current) {
    companionZoomRef.current = loadStoredCompanionZoom();
    companionZoomHydratedRef.current = true;
  }

  const setCompanionZoom = useCallback((value: number) => {
    const nextZoom = clampCompanionZoom(value);
    companionZoomRef.current = nextZoom;
    persistCompanionZoom(nextZoom);
    for (const engine of stageEnginesRef.current) {
      engine.setCompanionZoomNormalized(nextZoom);
    }
  }, []);

  const handleStageEngineReady = useCallback((engine: VrmEngine) => {
    engine.setCompanionZoomNormalized(companionZoomRef.current);
  }, []);

  const handleStageLayerEngineReady = useCallback(
    (_vrmPath: string, engine: VrmEngine) => {
      stageEnginesRef.current.add(engine);
      engine.setCompanionZoomNormalized(companionZoomRef.current);
      engine.setDragOrbitTarget(
        dragOrbitRef.current.yaw,
        dragOrbitRef.current.pitch,
      );
    },
    [],
  );

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!active || !interactive || shouldIgnoreCameraDrag(event.target)) {
        return;
      }
      if (typeof window.getSelection === "function") {
        window.getSelection()?.removeAllRanges();
      }
      if (event.pointerType === "touch") {
        touchPointsRef.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      if (event.pointerType === "touch" && touchPointsRef.current.size >= 2) {
        pinchStateRef.current = {
          active: true,
          startDistance: getTouchDistance(touchPointsRef.current),
          startZoom: companionZoomRef.current,
        };
        dragStateRef.current = {
          active: false,
          pointerId: null,
          startX: 0,
          startY: 0,
        };
        dragOrbitRef.current = { yaw: 0, pitch: 0 };
        for (const engine of stageEnginesRef.current) {
          engine.resetDragOrbit();
        }
        event.preventDefault?.();
        return;
      }
      dragStateRef.current = {
        active: true,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      event.preventDefault?.();
    },
    [active, interactive],
  );

  const handlePointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!active || !interactive) return;
      if (
        event.pointerType === "touch" &&
        touchPointsRef.current.has(event.pointerId)
      ) {
        touchPointsRef.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
        if (
          pinchStateRef.current.active &&
          touchPointsRef.current.size >= 2 &&
          pinchStateRef.current.startDistance > 0
        ) {
          const viewportSpan = Math.max(
            1,
            Math.min(
              window.innerWidth || event.currentTarget.clientWidth || 1,
              window.innerHeight || event.currentTarget.clientHeight || 1,
            ),
          );
          const pinchDistance = getTouchDistance(touchPointsRef.current);
          const zoomDelta =
            ((pinchDistance - pinchStateRef.current.startDistance) /
              viewportSpan) *
            COMPANION_ZOOM_PINCH_SENSITIVITY;
          setCompanionZoom(pinchStateRef.current.startZoom + zoomDelta);
          event.preventDefault();
          return;
        }
      }
      const dragState = dragStateRef.current;
      if (!dragState.active || dragState.pointerId !== event.pointerId) {
        return;
      }
      const width = window.innerWidth || event.currentTarget.clientWidth || 1;
      const height =
        window.innerHeight || event.currentTarget.clientHeight || 1;
      const deltaX = event.clientX - dragState.startX;
      const deltaY = event.clientY - dragState.startY;
      const yaw = (deltaX / width) * 1.35;
      const pitch = (-deltaY / height) * 0.85;
      dragOrbitRef.current = { yaw, pitch };
      for (const engine of stageEnginesRef.current) {
        engine.setDragOrbitTarget(yaw, pitch);
      }
      event.preventDefault();
    },
    [active, interactive, setCompanionZoom],
  );

  const handleWheelCapture = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!active || !interactive) return;
      const wheelPixels = getWheelPixels(event);
      if (Math.abs(wheelPixels) < 0.01) return;
      setCompanionZoom(
        companionZoomRef.current -
          wheelPixels * COMPANION_ZOOM_WHEEL_SENSITIVITY,
      );
      event.preventDefault();
    },
    [active, interactive, setCompanionZoom],
  );

  const handleRootWheelCapture = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!active || !interactive) return;
      if (hasFocusedTextEntry()) {
        if (event.ctrlKey) {
          event.preventDefault();
        }
        return;
      }
      handleWheelCapture(event);
    },
    [active, interactive, handleWheelCapture],
  );

  const releaseCameraDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "touch") {
        touchPointsRef.current.delete(event.pointerId);
        if (touchPointsRef.current.size < 2) {
          pinchStateRef.current = {
            active: false,
            startDistance: 0,
            startZoom: companionZoomRef.current,
          };
        }
      }
      const dragState = dragStateRef.current;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (dragState.pointerId !== event.pointerId) return;
      dragStateRef.current = {
        active: false,
        pointerId: null,
        startX: 0,
        startY: 0,
      };
      dragOrbitRef.current = { yaw: 0, pitch: 0 };
      for (const engine of stageEnginesRef.current) {
        engine.resetDragOrbit();
      }
    },
    [],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const preventGestureZoom = (event: Event) => {
      event.preventDefault();
    };

    root.addEventListener("gesturestart", preventGestureZoom, {
      passive: false,
    });
    root.addEventListener("gesturechange", preventGestureZoom, {
      passive: false,
    });
    root.addEventListener("gestureend", preventGestureZoom, {
      passive: false,
    });

    return () => {
      root.removeEventListener("gesturestart", preventGestureZoom);
      root.removeEventListener("gesturechange", preventGestureZoom);
      root.removeEventListener("gestureend", preventGestureZoom);
    };
  }, []);

  useEffect(() => {
    if (active && interactive) return;
    touchPointsRef.current.clear();
    pinchStateRef.current = {
      active: false,
      startDistance: 0,
      startZoom: companionZoomRef.current,
    };
    dragStateRef.current = {
      active: false,
      pointerId: null,
      startX: 0,
      startY: 0,
    };
    dragOrbitRef.current = { yaw: 0, pitch: 0 };
    for (const engine of stageEnginesRef.current) {
      engine.resetDragOrbit();
    }
  }, [active, interactive]);

  useEffect(() => {
    return () => {
      stageEnginesRef.current.clear();
    };
  }, []);

  const safeSelectedVrmIndex = selectedVrmIndex > 0 ? selectedVrmIndex : 1;
  const vrmPath =
    selectedVrmIndex === 0 && customVrmUrl
      ? customVrmUrl
      : getVrmUrl(safeSelectedVrmIndex);
  const fallbackPreviewUrl =
    selectedVrmIndex > 0
      ? getVrmPreviewUrl(safeSelectedVrmIndex)
      : getVrmPreviewUrl(1);
  const worldUrl =
    uiTheme === "dark"
      ? resolveAppAssetUrl("worlds/companion-night.spz")
      : resolveAppAssetUrl("worlds/companion-day.spz");
  const preloadAvatars = useMemo(() => {
    if (tab !== "character" && tab !== "character-select") {
      return [];
    }
    return Array.from({ length: VRM_COUNT }, (_, index) => {
      const avatarIndex = index + 1;
      return {
        vrmPath: getVrmUrl(avatarIndex),
        fallbackPreviewUrl: getVrmPreviewUrl(avatarIndex),
      };
    });
  }, [tab]);

  return (
    <div
      ref={rootRef}
      data-testid="companion-root"
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden text-white font-display"
      style={{
        overscrollBehavior: "none",
      }}
    >
      <div
        aria-hidden={!active}
        className={`fixed inset-0 z-0 overflow-hidden rounded-2xl bg-[radial-gradient(circle_at_50%_120%,#212942_0%,#12151e_80%)] transition-opacity duration-200 ${
          active ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        style={{
          visibility: active ? "visible" : "hidden",
        }}
      >
        <div className="absolute inset-0 z-0 bg-cover opacity-60 bg-[radial-gradient(circle_at_10%_20%,rgba(255,255,255,0.03)_0%,transparent_40%),radial-gradient(circle_at_80%_80%,rgba(0,225,255,0.05)_0%,transparent_40%)] pointer-events-none" />

        <VrmStage
          active={active}
          vrmPath={vrmPath}
          worldUrl={worldUrl}
          fallbackPreviewUrl={fallbackPreviewUrl}
          preloadAvatars={preloadAvatars}
          cameraProfile="companion"
          onEngineReady={handleStageEngineReady}
          onLayerEngineReady={handleStageLayerEngineReady}
          playWaveOnAvatarChange
          t={t}
        />

        <div
          aria-hidden="true"
          data-testid="companion-camera-drag-surface"
          className={`absolute inset-0 z-[1] select-none ${
            interactive ? "cursor-grab" : "pointer-events-none cursor-default"
          }`}
          onWheelCapture={handleRootWheelCapture}
          onPointerDownCapture={handlePointerDownCapture}
          onPointerMoveCapture={handlePointerMoveCapture}
          onPointerUpCapture={releaseCameraDrag}
          onPointerCancelCapture={releaseCameraDrag}
          onLostPointerCaptureCapture={releaseCameraDrag}
          style={{
            touchAction: "none",
            userSelect: "none",
            WebkitUserSelect: "none",
          }}
        />
      </div>

      {children}
    </div>
  );
}

export const CompanionSceneHost = memo(CompanionSceneSurface);

// Re-export the hook so existing imports from this module keep working.
export { useSharedCompanionScene } from "./shared-companion-scene-context";

export function SharedCompanionScene({
  active,
  interactive = true,
  children,
}: {
  active: boolean;
  interactive?: boolean;
  children: ReactNode;
}) {
  return (
    <SharedCompanionSceneContext.Provider value={true}>
      <CompanionSceneHost active={active} interactive={interactive}>
        {children}
      </CompanionSceneHost>
    </SharedCompanionSceneContext.Provider>
  );
}
