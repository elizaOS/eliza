import {
  dispatchAppEmoteEvent,
  getVrmPreviewUrl,
  getVrmUrl,
  resolveCharacterGreetingAnimation,
  useCompanionSceneConfig,
  useRenderGuard,
  useTranslation,
  VRM_COUNT,
  VRM_TELEPORT_COMPLETE_EVENT,
} from "@elizaos/ui";
import {
  memo,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { VrmEngine } from "../avatar/VrmEngine";
import { prefetchVrmToCache } from "../avatar/VrmEngine";
import { CompanionSceneStatusContext } from "./companion-scene-status-context";
import { SharedCompanionSceneContext } from "./shared-companion-scene-context";
import { VrmStage } from "./VrmStage";

const COMPANION_ZOOM_WHEEL_SENSITIVITY = 1 / 720;
const COMPANION_ZOOM_PINCH_SENSITIVITY = 2.35;
const COMPANION_ZOOM_STORAGE_KEY = "eliza.companion.zoom.v1";
const DEFAULT_COMPANION_ZOOM = 0.95;
const COMPANION_TELEPORT_GREETING_DELAY_MS = 400;
const CAMERA_DRAG_IGNORE_SELECTOR =
  'button, a, label, input, textarea, select, option, [role="button"], [role="listbox"], [role="tab"], [aria-expanded], [aria-haspopup], [contenteditable="true"], [data-no-camera-drag="true"]';
const CAMERA_ZOOM_IGNORE_SELECTOR = '[data-no-camera-zoom="true"]';
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

type CompanionWheelEvent = Pick<
  WheelEvent,
  "ctrlKey" | "deltaMode" | "deltaY" | "preventDefault" | "target"
>;

let _companionTeleportCompletedOnce = false;

export function hasCompanionTeleportCompletedOnce(): boolean {
  return _companionTeleportCompletedOnce;
}

function getTouchDistance(points: Map<number, TouchPoint>): number {
  const touchPoints = [...points.values()];
  if (touchPoints.length < 2) return 0;
  const [firstPoint, secondPoint] = touchPoints;
  if (!firstPoint || !secondPoint) return 0;
  return Math.hypot(secondPoint.x - firstPoint.x, secondPoint.y - firstPoint.y);
}

function getWheelPixels(
  event: Pick<WheelEvent, "deltaMode" | "deltaY">,
): number {
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

function shouldIgnoreCameraZoom(target: EventTarget | null): boolean {
  return target instanceof Element
    ? Boolean(target.closest(CAMERA_ZOOM_IGNORE_SELECTOR))
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
  } catch (err) {
    console.warn(
      "[CompanionSceneHost] Failed to load stored companion zoom:",
      err,
    );
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
  } catch (err) {
    console.warn("[CompanionSceneHost] Failed to persist companion zoom:", err);
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
  const {
    selectedVrmIndex,
    customVrmUrl,
    uiTheme,
    tab,
    companionVrmPowerMode,
    companionHalfFramerateMode,
    companionAnimateWhenHidden,
  } = useCompanionSceneConfig();
  const { t } = useTranslation();
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

  // Lazy-mount VrmStage: only initialize the 3D engine once the scene is
  // actually needed (first time active becomes true). This prevents the WebGL
  // context and asset loads from firing in native/chat mode on startup.
  const hasEverBeenActiveRef = useRef(active);
  if (active) hasEverBeenActiveRef.current = true;
  const shouldMountVrm = hasEverBeenActiveRef.current;

  const setCompanionZoom = useCallback((value: number) => {
    const nextZoom = clampCompanionZoom(value);
    companionZoomRef.current = nextZoom;
    persistCompanionZoom(nextZoom);
    for (const engine of stageEnginesRef.current) {
      engine.setCompanionZoomNormalized(nextZoom);
    }
  }, []);

  const handleStageEngineReady = useCallback((engine: VrmEngine) => {
    stageEnginesRef.current.add(engine);
    engine.setCompanionZoomNormalized(companionZoomRef.current);
    engine.setDragOrbitTarget(
      dragOrbitRef.current.yaw,
      dragOrbitRef.current.pitch,
    );
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
      /* Stop event from reaching children — this is a camera drag */
      event.stopPropagation();
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
    (event: CompanionWheelEvent) => {
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
    (event: CompanionWheelEvent) => {
      if (!active || !interactive) return;
      if (hasFocusedTextEntry()) {
        event.preventDefault();
        return;
      }
      if (shouldIgnoreCameraZoom(event.target)) {
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

  const safeSelectedVrmIndex = selectedVrmIndex > 0 ? selectedVrmIndex : 1;
  const vrmPath =
    selectedVrmIndex === 0 && customVrmUrl
      ? customVrmUrl
      : getVrmUrl(safeSelectedVrmIndex);
  const fallbackPreviewUrl =
    selectedVrmIndex > 0
      ? getVrmPreviewUrl(safeSelectedVrmIndex)
      : getVrmPreviewUrl(1);
  const teleportKey = vrmPath;
  const [teleportCompletedKey, setTeleportCompletedKey] = useState<
    string | null
  >(null);
  const teleportKeyRef = useRef(teleportKey);
  const greetingAnimationPathRef = useRef<string | null>(
    resolveCharacterGreetingAnimation({ avatarIndex: selectedVrmIndex }),
  );
  const greetingEmoteTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const handleTeleportComplete = () => {
      _companionTeleportCompletedOnce = true;
      setTeleportCompletedKey(teleportKeyRef.current);
      if (greetingEmoteTimerRef.current != null) {
        window.clearTimeout(greetingEmoteTimerRef.current);
      }
      // Give the idle blend a moment to settle after the dissolve before
      // cross-fading into the greeting emote.
      greetingEmoteTimerRef.current = window.setTimeout(() => {
        greetingEmoteTimerRef.current = null;
        const greetingAnimationPath = greetingAnimationPathRef.current;
        if (!greetingAnimationPath) {
          return;
        }
        dispatchAppEmoteEvent({
          emoteId: "greeting",
          path: `/${greetingAnimationPath}`,
          duration: 3,
          loop: false,
          showOverlay: false,
        });
      }, COMPANION_TELEPORT_GREETING_DELAY_MS);
    };
    window.addEventListener(
      VRM_TELEPORT_COMPLETE_EVENT,
      handleTeleportComplete,
    );
    return () => {
      window.removeEventListener(
        VRM_TELEPORT_COMPLETE_EVENT,
        handleTeleportComplete,
      );
      if (greetingEmoteTimerRef.current != null) {
        window.clearTimeout(greetingEmoteTimerRef.current);
        greetingEmoteTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handleNativeWheel = (event: WheelEvent) => {
      handleRootWheelCapture(event);
    };

    root.addEventListener("wheel", handleNativeWheel, {
      capture: true,
      passive: false,
    });

    return () => {
      root.removeEventListener("wheel", handleNativeWheel, {
        capture: true,
      });
    };
  }, [handleRootWheelCapture]);

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

  /* ── Camera X-offset for CharacterEditor panel ──────────────────── */
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ offset: number }>).detail;
      const offset = detail?.offset ?? 0;
      for (const engine of stageEnginesRef.current) {
        engine.setCameraXOffset(offset);
      }
    };
    window.addEventListener("eliza:editor-camera-offset", handler);
    return () =>
      window.removeEventListener("eliza:editor-camera-offset", handler);
  }, []);
  const avatarReady = teleportCompletedKey === teleportKey;
  const sceneStatus = useMemo(
    () => ({
      avatarReady,
      teleportKey,
    }),
    [avatarReady, teleportKey],
  );

  useEffect(() => {
    greetingAnimationPathRef.current = resolveCharacterGreetingAnimation({
      avatarIndex: selectedVrmIndex,
    });
  }, [selectedVrmIndex]);

  useEffect(() => {
    teleportKeyRef.current = teleportKey;
    _companionTeleportCompletedOnce = false;
    setTeleportCompletedKey(null);
    if (greetingEmoteTimerRef.current != null) {
      window.clearTimeout(greetingEmoteTimerRef.current);
      greetingEmoteTimerRef.current = null;
    }
  }, [teleportKey]);

  const preloadPreviews = useMemo(() => {
    if (tab !== "character" && tab !== "character-select") {
      return [];
    }
    return Array.from({ length: VRM_COUNT }, (_, index) => {
      const avatarIndex = index + 1;
      return { previewUrl: getVrmPreviewUrl(avatarIndex) };
    });
  }, [tab]);

  /* ── Preload only lightweight preview thumbnails (~80KB each) for the
   *    character-select grid. Full VRMs (~10MB each) are fetched on-demand
   *    when the user actually selects an avatar, and cached in-memory by
   *    VrmEngine so subsequent swaps skip the network entirely. ── */
  const preloadedRef = useRef(false);
  useEffect(() => {
    if (preloadedRef.current || preloadPreviews.length === 0) return;
    preloadedRef.current = true;
    for (const entry of preloadPreviews) {
      const img = new Image();
      img.src = entry.previewUrl;
    }
  }, [preloadPreviews]);

  /* ── Prefetch VRM buffers into the in-memory cache as soon as the character
   *    tab opens. Fire-and-forget: errors are silently swallowed inside
   *    prefetchVrmToCache. This converts the first character-click from a
   *    cold ~3-8 s network fetch into a <200 ms re-parse from cached bytes. ── */
  const vrmPrefetchedRef = useRef(false);
  useEffect(() => {
    if (tab !== "character" && tab !== "character-select") return;
    if (vrmPrefetchedRef.current) return;
    vrmPrefetchedRef.current = true;
    for (let i = 1; i <= VRM_COUNT; i++) {
      void prefetchVrmToCache(getVrmUrl(i));
    }
  }, [tab]);

  return (
    <div
      ref={rootRef}
      data-testid="companion-root"
      data-avatar-ready={avatarReady ? "true" : "false"}
      data-no-window-drag=""
      className={`relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden text-[#1a1a2e] font-display ${interactive ? "cursor-grab" : ""}`}
      style={{
        overscrollBehavior: "none",
        touchAction: interactive ? "none" : undefined,
      }}
      onPointerDownCapture={handlePointerDownCapture}
      onPointerMoveCapture={handlePointerMoveCapture}
      onPointerUpCapture={releaseCameraDrag}
      onPointerCancelCapture={releaseCameraDrag}
      onLostPointerCaptureCapture={releaseCameraDrag}
    >
      <div
        data-testid="companion-background"
        data-theme={uiTheme === "dark" ? "dark" : "light"}
        aria-hidden={!active}
        className={`fixed inset-0 z-0 overflow-hidden transition-opacity duration-200 ${
          uiTheme === "dark" ? "bg-[#08060e]" : "bg-[#f5f5f5]"
        } ${active ? "opacity-100" : "pointer-events-none opacity-0"}`}
        style={{
          visibility: active ? "visible" : "hidden",
        }}
      >
        <div
          className={`absolute inset-0 z-0 bg-cover opacity-40 pointer-events-none ${
            uiTheme === "dark"
              ? "bg-[radial-gradient(circle_at_50%_40%,rgba(80,20,140,0.2)_0%,transparent_60%)]"
              : "bg-[radial-gradient(circle_at_50%_40%,rgba(180,200,220,0.15)_0%,transparent_60%)]"
          }`}
        />

        {shouldMountVrm && (
          <VrmStage
            active={active}
            vrmPath={vrmPath}
            fallbackPreviewUrl={fallbackPreviewUrl}
            environmentTheme={uiTheme === "dark" ? "dark" : "light"}
            cameraProfile="companion"
            companionVrmPowerMode={companionVrmPowerMode}
            companionHalfFramerateMode={companionHalfFramerateMode}
            companionAnimateWhenHidden={companionAnimateWhenHidden}
            onEngineReady={handleStageEngineReady}
            onLayerEngineReady={handleStageLayerEngineReady}
            playWaveOnAvatarChange={false}
            t={t}
          />
        )}
      </div>

      <CompanionSceneStatusContext.Provider value={sceneStatus}>
        {children}
      </CompanionSceneStatusContext.Provider>
    </div>
  );
}

// Do NOT use a custom memo comparator that ignores children here.
// shellContent (which includes ViewRouter / tab content) is passed as
// children — ignoring children changes blocks all tab navigation.
// If keystroke re-renders are a concern, memoize shellContent in App.tsx.
export const CompanionSceneHost = memo(CompanionSceneSurface);

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
