/**
 * VRM avatar canvas component.
 *
 * Renders a VRM model with idle animation and mouth-sync driven by
 * the `mouthOpen` prop. Sized to fill its parent container.
 */

import { useEffect, useEffectEvent, useRef } from "react";
import { getVrmCount, getVrmUrl } from "../../state/vrm";
import {
  type CameraProfile,
  type InteractionMode,
  VrmEngine,
  type VrmEngineDebugInfo,
  type VrmEngineState,
} from "./VrmEngine";

const DEFAULT_VRM_PATH = getVrmUrl(1);

export type VrmViewerProps = {
  /** When false the loaded scene stays resident but the render loop is paused */
  active?: boolean;
  /** Path to the VRM file to load (default: bundled Miwaifus #1) */
  vrmPath?: string;
  mouthOpen: number;
  /** When true the engine generates mouth animation internally */
  isSpeaking?: boolean;
  /** Enable drag-rotate + wheel/pinch zoom camera controls */
  interactive?: boolean;
  /** Camera profile preset (chat default, companion for hero-stage framing) */
  cameraProfile?: CameraProfile;
  /** Interaction behavior for camera controls */
  interactiveMode?: InteractionMode;
  /** Optional Gaussian splat world behind the avatar */
  worldUrl?: string;
  /** Enable springy drag/touch camera offset instead of orbit controls */
  pointerParallax?: boolean;
  onEngineState?: (state: VrmEngineState) => void;
  onEngineReady?: (engine: VrmEngine) => void;
  onRevealStart?: () => void;
};

type VrmEngineDebugRegistryEntry = {
  id: string;
  role: "world-stage" | "chat-avatar";
  vrmPath: string;
  worldUrl: string | null;
  engine: VrmEngine;
  getDebugInfo: () => VrmEngineDebugInfo;
};

declare global {
  interface Window {
    __ELIZA_VRM_ENGINES__?: VrmEngineDebugRegistryEntry[];
    __captureVrmPreviews__?: typeof captureVrmPreviews;
  }
}

/**
 * Dev utility: capture preview PNGs for all bundled VRM avatars with spring bone
 * physics disabled (hair/cloth in rest pose). Call from the browser console:
 *
 *   await window.__captureVrmPreviews__()
 *
 * Each VRM is loaded in sequence, a snapshot is taken with physics frozen, and
 * the resulting PNG is downloaded. The existing world-stage engine is reused
 * if available; otherwise a temporary offscreen engine is created.
 */
async function captureVrmPreviews(options?: {
  width?: number;
  height?: number;
}): Promise<void> {
  const width = options?.width ?? 512;
  const height = options?.height ?? 768;

  // Try to reuse the existing world-stage engine, fall back to any available engine
  const registry = window.__ELIZA_VRM_ENGINES__ ?? [];
  const registryEntry =
    registry.find((e) => e.role === "world-stage") ?? registry[0] ?? null;
  const engine = registryEntry?.engine ?? null;
  if (!engine) {
    console.error(
      "[captureVrmPreviews] No active VRM engine found. Navigate to the character view first.",
    );
    return;
  }

  const count = getVrmCount();
  console.log(`[captureVrmPreviews] Capturing ${count} VRM previews at ${width}×${height} with physics disabled...`);

  for (let i = 1; i <= count; i++) {
    const vrmUrl = getVrmUrl(i);
    const slug = vrmUrl.split("/").pop()?.replace(/\.vrm(\.gz)?$/, "") ?? `vrm-${i}`;

    console.log(`[captureVrmPreviews] Loading VRM ${i}/${count}: ${slug}...`);
    try {
      await engine.loadVrmFromUrl(vrmUrl, slug);
      // Let the idle animation settle
      await new Promise((resolve) => setTimeout(resolve, 500));

      const blob = await engine.snapshot({ width, height, disablePhysics: true });
      if (!blob) {
        console.warn(`[captureVrmPreviews] Failed to capture ${slug}`);
        continue;
      }

      // Download the PNG
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${slug}.png`;
      a.click();
      URL.revokeObjectURL(url);
      console.log(`[captureVrmPreviews] Saved ${slug}.png`);
    } catch (err) {
      console.error(`[captureVrmPreviews] Error capturing ${slug}:`, err);
    }
  }

  console.log("[captureVrmPreviews] Done!");
}

// Expose globally in dev mode
if (typeof window !== "undefined") {
  window.__captureVrmPreviews__ = captureVrmPreviews;
}

export function VrmViewer(props: VrmViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<VrmEngine | null>(null);
  const mouthOpenRef = useRef<number>(props.mouthOpen);
  const activeRef = useRef<boolean>(props.active ?? true);
  const isSpeakingRef = useRef<boolean>(props.isSpeaking ?? false);
  const interactiveRef = useRef<boolean>(props.interactive ?? false);
  const cameraProfileRef = useRef<CameraProfile>(props.cameraProfile ?? "chat");
  const interactionModeRef = useRef<InteractionMode>(
    props.interactiveMode ?? "free",
  );
  const pointerParallaxRef = useRef<boolean>(props.pointerParallax ?? false);
  const worldUrlRef = useRef<string>(props.worldUrl ?? "");
  const prefersWorldRendererRef = useRef<boolean>(Boolean(props.worldUrl));
  const lastStateEmitMsRef = useRef<number>(0);
  const mountedRef = useRef(true);
  const currentVrmPathRef = useRef<string>("");
  const currentWorldPathRef = useRef<string>("");
  const worldLoadPromiseRef = useRef<Promise<void> | null>(null);
  const pointerStateRef = useRef<{
    active: boolean;
    id: number | null;
    startX: number;
    startY: number;
  }>({
    active: false,
    id: null,
    startX: 0,
    startY: 0,
  });
  const onEngineReadyRef = useRef(props.onEngineReady);
  const onEngineStateRef = useRef(props.onEngineState);
  const onRevealStartRef = useRef(props.onRevealStart);
  const revealStartedRef = useRef(false);
  const debugRegistryIdRef = useRef(
    `vrm-viewer-${Math.random().toString(36).slice(2, 10)}`,
  );

  mouthOpenRef.current = props.mouthOpen;
  activeRef.current = props.active ?? true;
  isSpeakingRef.current = props.isSpeaking ?? false;
  interactiveRef.current = props.interactive ?? false;
  cameraProfileRef.current = props.cameraProfile ?? "chat";
  interactionModeRef.current = props.interactiveMode ?? "free";
  pointerParallaxRef.current = props.pointerParallax ?? false;
  worldUrlRef.current = props.worldUrl ?? "";
  prefersWorldRendererRef.current = Boolean(props.worldUrl);
  onEngineReadyRef.current = props.onEngineReady;
  onEngineStateRef.current = props.onEngineState;
  onRevealStartRef.current = props.onRevealStart;

  const syncDebugRegistry = useEffectEvent(() => {
    if (!import.meta.env.DEV) return;
    if (typeof window === "undefined") return;
    const engine = engineRef.current;
    const registry = window.__ELIZA_VRM_ENGINES__ ?? [];
    const id = debugRegistryIdRef.current;
    const nextEntry: VrmEngineDebugRegistryEntry | null = engine
      ? {
          id,
          role: props.worldUrl ? "world-stage" : "chat-avatar",
          vrmPath: props.vrmPath ?? DEFAULT_VRM_PATH,
          worldUrl: props.worldUrl ?? null,
          engine,
          getDebugInfo: () => engine.getDebugInfo(),
        }
      : null;

    window.__ELIZA_VRM_ENGINES__ = nextEntry
      ? [...registry.filter((entry) => entry.id !== id), nextEntry]
      : registry.filter((entry) => entry.id !== id);
  });

  // Setup engine once
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    mountedRef.current = true;

    let engine = engineRef.current;
    if (!engine || !engine.isInitialized()) {
      engine = new VrmEngine();
      engineRef.current = engine;
    }

    engine.setup(
      canvas,
      () => {
        // Frame loop: guard all state-setting calls against unmount.
        if (!mountedRef.current) return;
        engine.setMouthOpen(mouthOpenRef.current);
        engine.setSpeaking(isSpeakingRef.current);
        const now = performance.now();
        if (now - lastStateEmitMsRef.current >= 250) {
          lastStateEmitMsRef.current = now;
          const state = engine.getState();
          if (state.revealStarted && !revealStartedRef.current) {
            revealStartedRef.current = true;
            onRevealStartRef.current?.();
          }
          onEngineStateRef.current?.(state);
        }
      },
      {
        rendererPreference: prefersWorldRendererRef.current ? "webgl" : "auto",
        sparkOptimized: prefersWorldRendererRef.current,
      },
    );
    engine.setPaused(!activeRef.current);

    // One-time initial camera/control setup (subsequent changes handled by effects).
    engine.setCameraProfile(cameraProfileRef.current);
    engine.setInteractionMode(interactionModeRef.current);
    engine.setInteractionEnabled(interactiveRef.current);
    engine.setPointerParallaxEnabled(pointerParallaxRef.current);

    const resize = () => {
      const el = canvasRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      engine.resize(rect.width, rect.height);
    };
    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => resize())
        : null;
    resizeObserver?.observe(canvas);
    window.addEventListener("resize", resize);
    void engine.whenReady().then(
      () => {
        if (!mountedRef.current) return;
        resize();
        syncDebugRegistry();
        onEngineReadyRef.current?.(engine);
      },
      (error) => {
        console.warn("Failed to initialize VRM renderer:", error);
      },
    );

    return () => {
      mountedRef.current = false;
      window.removeEventListener("resize", resize);
      resizeObserver?.disconnect();

      engine.dispose();
      if (engineRef.current === engine) {
        engineRef.current = null;
      }
      syncDebugRegistry();
    };
  }, []);

  useEffect(() => {
    syncDebugRegistry();
  });

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setPaused(!(props.active ?? true));
  }, [props.active]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setInteractionEnabled(props.interactive ?? false);
  }, [props.interactive]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setCameraProfile(props.cameraProfile ?? "chat");
  }, [props.cameraProfile]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setInteractionMode(props.interactiveMode ?? "free");
  }, [props.interactiveMode]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setPointerParallaxEnabled(props.pointerParallax ?? false);
    if (!(props.pointerParallax ?? false)) {
      engine.resetPointerParallax();
    }
  }, [props.pointerParallax]);

  // Load VRM when path changes
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    const vrmUrl = props.vrmPath ?? DEFAULT_VRM_PATH;
    if (vrmUrl === currentVrmPathRef.current) return;
    currentVrmPathRef.current = vrmUrl;
    revealStartedRef.current = false;

    const abortController = new AbortController();

    void (async () => {
      try {
        await engine.whenReady();
        if (!mountedRef.current || abortController.signal.aborted) return;
        const worldUrl = worldUrlRef.current;
        if (worldUrl) {
          if (worldUrl !== currentWorldPathRef.current) {
            currentWorldPathRef.current = worldUrl;
            const worldLoadPromise = (async () => {
              await engine.setWorldUrl(worldUrl);
            })();
            worldLoadPromiseRef.current = worldLoadPromise;
            try {
              await worldLoadPromise;
            } finally {
              if (worldLoadPromiseRef.current === worldLoadPromise) {
                worldLoadPromiseRef.current = null;
              }
            }
          } else if (worldLoadPromiseRef.current) {
            await worldLoadPromiseRef.current;
          }
        }
        if (!mountedRef.current || abortController.signal.aborted) return;
        await engine.loadVrmFromUrl(
          vrmUrl,
          vrmUrl.split("/").pop() ?? "avatar.vrm",
        );
        if (!mountedRef.current || abortController.signal.aborted) return;
        const state = engine.getState();
        if (state.revealStarted && !revealStartedRef.current) {
          revealStartedRef.current = true;
          onRevealStartRef.current?.();
        }
        onEngineStateRef.current?.(state);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        if (currentVrmPathRef.current === vrmUrl) {
          currentVrmPathRef.current = "";
        }
        console.warn("Failed to load VRM:", err);
      }
    })();

    return () => {
      abortController.abort();
      if (currentVrmPathRef.current === vrmUrl) {
        currentVrmPathRef.current = "";
      }
    };
  }, [props.vrmPath]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    const worldUrl = props.worldUrl ?? "";
    if (worldUrl === currentWorldPathRef.current) return;
    currentWorldPathRef.current = worldUrl;
    const abortController = new AbortController();

    let worldLoadPromise: Promise<void> | null = null;
    worldLoadPromise = (async () => {
      try {
        await engine.whenReady();
        if (!mountedRef.current || abortController.signal.aborted) return;
        await engine.setWorldUrl(worldUrl || null);
      } catch (err) {
        console.warn("Failed to load splat world:", err);
      } finally {
        if (worldLoadPromiseRef.current === worldLoadPromise) {
          worldLoadPromiseRef.current = null;
        }
      }
    })();
    worldLoadPromiseRef.current = worldLoadPromise;

    return () => {
      abortController.abort();
      if (currentWorldPathRef.current === worldUrl) {
        currentWorldPathRef.current = "";
      }
      if (worldLoadPromiseRef.current === worldLoadPromise) {
        worldLoadPromiseRef.current = null;
      }
    };
  }, [props.worldUrl]);

  const updateParallaxFromPointer = (
    clientX: number,
    clientY: number,
    release = false,
  ) => {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    const pointerState = pointerStateRef.current;
    if (!engine || !canvas || !pointerParallaxRef.current) return;
    if (release) {
      engine.resetPointerParallax();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const deltaX = clientX - pointerState.startX;
    const deltaY = clientY - pointerState.startY;
    const normalizedX = rect.width > 0 ? deltaX / rect.width : 0;
    const normalizedY = rect.height > 0 ? deltaY / rect.height : 0;
    engine.setPointerParallaxTarget(normalizedX * 2.2, -normalizedY * 2.2);
  };

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={(event) => {
        if (!pointerParallaxRef.current) return;
        pointerStateRef.current = {
          active: true,
          id: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const pointerState = pointerStateRef.current;
        if (
          !pointerParallaxRef.current ||
          !pointerState.active ||
          pointerState.id !== event.pointerId
        ) {
          return;
        }
        updateParallaxFromPointer(event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        const pointerState = pointerStateRef.current;
        if (pointerState.id !== event.pointerId) return;
        pointerStateRef.current.active = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
        updateParallaxFromPointer(event.clientX, event.clientY, true);
      }}
      onPointerCancel={(event) => {
        const pointerState = pointerStateRef.current;
        if (pointerState.id !== event.pointerId) return;
        pointerStateRef.current.active = false;
        updateParallaxFromPointer(event.clientX, event.clientY, true);
      }}
      style={{
        position: "absolute",
        inset: 0,
        display: "block",
        width: "100vw",
        height: "100vh",
        minWidth: "100vw",
        minHeight: "100vh",
        background: "transparent",
        cursor: props.pointerParallax || props.interactive ? "grab" : "default",
        touchAction: props.pointerParallax ? "none" : "auto",
      }}
    />
  );
}
