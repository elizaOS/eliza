import {
  APP_EMOTE_EVENT,
  type AppEmoteEventDetail,
  STOP_EMOTE_EVENT,
} from "@elizaos/app-core/events";
import {
  useChatAvatarVoiceState,
  useRenderGuard,
} from "@elizaos/app-core/hooks";
import { resolveAppAssetUrl } from "@elizaos/app-core/utils";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AvatarLoader } from "./AvatarLoader";
import type {
  CameraProfile,
  VrmEngine,
  VrmEngineState,
} from "./avatar/VrmEngine";
import { VrmViewer } from "./avatar/VrmViewer";

type TranslateFn = (key: string) => string;

const AVATAR_CHANGE_WAVE_DELAY_MS = 650;
const AVATAR_SWITCH_FADE_DURATION_MS = 650;
const AVATAR_CHANGE_WAVE_EMOTE: AppEmoteEventDetail = {
  emoteId: "wave",
  path: "/animations/emotes/waving-both-hands.glb",
  duration: 2.5,
  loop: false,
  showOverlay: false,
};

export type VrmStageAvatarEntry = {
  vrmPath: string;
  fallbackPreviewUrl: string;
};

const VrmStageLayer = memo(function VrmStageLayer({
  active,
  visible,
  opacity,
  zIndex,
  vrmPath,
  worldUrl,
  fallbackPreviewUrl,
  cameraProfile,
  initialCompanionZoomNormalized,
  onEngineReady,
  onRevealStart,
  t,
}: {
  active: boolean;
  visible: boolean;
  opacity: number;
  zIndex: number;
  vrmPath: string;
  worldUrl?: string;
  fallbackPreviewUrl: string;
  cameraProfile: CameraProfile;
  initialCompanionZoomNormalized?: number;
  onEngineReady?: (vrmPath: string, engine: VrmEngine) => void;
  onRevealStart?: (vrmPath: string) => void;
  t: TranslateFn;
}) {
  const [vrmLoaded, setVrmLoaded] = useState(false);
  const [showVrmFallback, setShowVrmFallback] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState<number | undefined>(undefined);
  const chatAvatarVoice = useChatAvatarVoiceState();

  const handleVrmEngineReady = useCallback(
    (engine: VrmEngine) => {
      engine.setPaused(!active);
      engine.setCameraAnimation({
        enabled: true,
        swayAmplitude: cameraProfile === "companion_close" ? 0.028 : 0.04,
        bobAmplitude: cameraProfile === "companion_close" ? 0.016 : 0.022,
        rotationAmplitude: cameraProfile === "companion_close" ? 0.008 : 0.012,
        speed: cameraProfile === "companion_close" ? 0.48 : 0.42,
      });
      engine.setPointerParallaxEnabled(false);
      if (typeof initialCompanionZoomNormalized === "number") {
        engine.setCompanionZoomNormalized(initialCompanionZoomNormalized);
      }
      onEngineReady?.(vrmPath, engine);
    },
    [
      active,
      cameraProfile,
      initialCompanionZoomNormalized,
      onEngineReady,
      vrmPath,
    ],
  );

  const handleVrmEngineState = useCallback((state: VrmEngineState) => {
    if (state.loadingProgress !== undefined) {
      setLoadingProgress(Math.round(state.loadingProgress * 100));
    }
    if (state.vrmLoaded) {
      setVrmLoaded(true);
      setShowVrmFallback(false);
      return;
    }
    if (state.loadError) {
      setVrmLoaded(false);
      setShowVrmFallback(true);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the layer UI when the requested VRM changes.
  useEffect(() => {
    setVrmLoaded(false);
    setShowVrmFallback(false);
  }, [vrmPath]);

  return (
    <>
      <div
        className="absolute inset-0 z-10"
        style={{
          opacity,
          zIndex,
          visibility: visible ? "visible" : "hidden",
          transition: `opacity ${AVATAR_SWITCH_FADE_DURATION_MS}ms ease`,
        }}
      >
        <VrmViewer
          active={active}
          vrmPath={vrmPath}
          worldUrl={worldUrl}
          mouthOpen={chatAvatarVoice.mouthOpen}
          isSpeaking={chatAvatarVoice.isSpeaking}
          cameraProfile={cameraProfile}
          onEngineReady={handleVrmEngineReady}
          onEngineState={handleVrmEngineState}
          onRevealStart={() => onRevealStart?.(vrmPath)}
        />
      </div>
      {visible && showVrmFallback && !vrmLoaded && (
        <img
          src={fallbackPreviewUrl}
          alt={t("companion.avatarPreviewAlt")}
          className="absolute left-1/2 top-[52%] -translate-x-1/2 -translate-y-1/2 h-[90%] object-contain opacity-70"
          style={{ zIndex }}
        />
      )}
      {visible && !vrmLoaded && !showVrmFallback && (
        <div className="absolute inset-0" style={{ zIndex }}>
          <AvatarLoader progress={loadingProgress} />
        </div>
      )}
    </>
  );
});

export const VrmStage = memo(function VrmStage({
  active = true,
  vrmPath,
  worldUrl,
  fallbackPreviewUrl,
  cameraProfile = "companion",
  initialCompanionZoomNormalized,
  onEngineReady,
  onLayerEngineReady,
  onRevealStart,
  playWaveOnAvatarChange = false,
  preloadAvatars = [],
  t,
}: {
  active?: boolean;
  vrmPath: string;
  worldUrl?: string;
  fallbackPreviewUrl: string;
  cameraProfile?: CameraProfile;
  initialCompanionZoomNormalized?: number;
  onEngineReady?: (engine: VrmEngine) => void;
  onLayerEngineReady?: (vrmPath: string, engine: VrmEngine) => void;
  onRevealStart?: () => void;
  playWaveOnAvatarChange?: boolean;
  preloadAvatars?: readonly VrmStageAvatarEntry[];
  t: TranslateFn;
}) {
  useRenderGuard("VrmStage");
  const [currentPath, setCurrentPath] = useState(vrmPath);
  const [outgoingPath, setOutgoingPath] = useState<string | null>(null);
  const [outgoingOpacity, setOutgoingOpacity] = useState(1);
  const currentPathRef = useRef(vrmPath);
  const currentEngineRef = useRef<VrmEngine | null>(null);
  const enginesRef = useRef(new Map<string, VrmEngine>());
  const avatarChangeWaveTimerRef = useRef<number | null>(null);
  const transitionTimerRef = useRef<number | null>(null);
  const transitionFrameRef = useRef<number | null>(null);
  const pendingWavePathRef = useRef<string | null>(null);
  const hasMountedRef = useRef(false);
  const fallbackPreviewByPathRef = useRef(new Map<string, string>());

  fallbackPreviewByPathRef.current.set(vrmPath, fallbackPreviewUrl);
  for (const avatar of preloadAvatars) {
    fallbackPreviewByPathRef.current.set(
      avatar.vrmPath,
      avatar.fallbackPreviewUrl,
    );
  }

  useEffect(() => {
    const currentEngine = enginesRef.current.get(currentPath) ?? null;
    currentEngineRef.current = currentEngine;
    if (currentEngine) {
      onEngineReady?.(currentEngine);
    }
  }, [currentPath, onEngineReady]);

  const playGreetingWave = useCallback((engine: VrmEngine | null) => {
    if (!engine) return;
    const resolvedPath = resolveAppAssetUrl(AVATAR_CHANGE_WAVE_EMOTE.path);
    void engine.playEmote(
      resolvedPath,
      AVATAR_CHANGE_WAVE_EMOTE.duration ?? 3,
      AVATAR_CHANGE_WAVE_EMOTE.loop === true,
    );
  }, []);

  const scheduleGreetingWave = useCallback(() => {
    if (!active || !playWaveOnAvatarChange) return;
    if (pendingWavePathRef.current !== currentPath) return;
    const engine = enginesRef.current.get(currentPath) ?? null;
    if (!engine) return;
    if (avatarChangeWaveTimerRef.current != null) {
      window.clearTimeout(avatarChangeWaveTimerRef.current);
    }
    avatarChangeWaveTimerRef.current = window.setTimeout(() => {
      playGreetingWave(engine);
      avatarChangeWaveTimerRef.current = null;
    }, AVATAR_CHANGE_WAVE_DELAY_MS);
    pendingWavePathRef.current = null;
  }, [active, currentPath, playGreetingWave, playWaveOnAvatarChange]);

  const handleLayerEngineReady = useCallback(
    (layerPath: string, engine: VrmEngine) => {
      enginesRef.current.set(layerPath, engine);
      onLayerEngineReady?.(layerPath, engine);
      if (layerPath === currentPathRef.current) {
        currentEngineRef.current = engine;
        onEngineReady?.(engine);
      }
      scheduleGreetingWave();
    },
    [onEngineReady, onLayerEngineReady, scheduleGreetingWave],
  );

  const handleRevealStart = useCallback(
    (layerPath: string) => {
      if (layerPath !== currentPathRef.current) return;
      onRevealStart?.();
      scheduleGreetingWave();
    },
    [onRevealStart, scheduleGreetingWave],
  );

  useEffect(() => {
    currentEngineRef.current?.setPaused(!active);
  }, [active]);

  useEffect(() => {
    if (typeof initialCompanionZoomNormalized !== "number") return;
    currentEngineRef.current?.setCompanionZoomNormalized(
      initialCompanionZoomNormalized,
    );
  }, [initialCompanionZoomNormalized]);

  useEffect(() => {
    if (vrmPath === currentPathRef.current) {
      if (!hasMountedRef.current) {
        pendingWavePathRef.current = vrmPath;
      }
      hasMountedRef.current = true;
      scheduleGreetingWave();
      return;
    }

    const previousPath = currentPathRef.current;
    currentPathRef.current = vrmPath;
    setCurrentPath(vrmPath);
    setOutgoingPath(previousPath);
    setOutgoingOpacity(1);

    if (transitionTimerRef.current != null) {
      window.clearTimeout(transitionTimerRef.current);
    }
    if (transitionFrameRef.current != null) {
      window.cancelAnimationFrame(transitionFrameRef.current);
    }

    transitionFrameRef.current = window.requestAnimationFrame(() => {
      setOutgoingOpacity(0);
      transitionFrameRef.current = null;
    });

    transitionTimerRef.current = window.setTimeout(() => {
      setOutgoingPath((candidate) =>
        candidate === previousPath ? null : candidate,
      );
      setOutgoingOpacity(1);
      transitionTimerRef.current = null;
    }, AVATAR_SWITCH_FADE_DURATION_MS);

    if (hasMountedRef.current) {
      pendingWavePathRef.current = vrmPath;
    }
    hasMountedRef.current = true;
  }, [vrmPath, scheduleGreetingWave]);

  useEffect(() => {
    const handler = (event: Event) => {
      const engine = currentEngineRef.current;
      if (!engine) return;
      if (typeof engine.playEmote !== "function") return;
      const detail = (event as CustomEvent<AppEmoteEventDetail>).detail;
      if (!detail?.path) return;
      const resolvedPath = resolveAppAssetUrl(detail.path);
      const duration =
        typeof detail.duration === "number" && Number.isFinite(detail.duration)
          ? detail.duration
          : 3;
      const isLoop = detail.loop === true;
      void engine.playEmote(resolvedPath, duration, isLoop);
    };
    window.addEventListener(APP_EMOTE_EVENT, handler);
    return () => window.removeEventListener(APP_EMOTE_EVENT, handler);
  }, []);

  // Listen for stop-emote events from the EmotePicker "Stop" button.
  useEffect(() => {
    const handler = () => {
      currentEngineRef.current?.stopEmote();
    };
    document.addEventListener(STOP_EMOTE_EVENT, handler);
    return () => document.removeEventListener(STOP_EMOTE_EVENT, handler);
  }, []);

  useEffect(() => {
    return () => {
      if (avatarChangeWaveTimerRef.current != null) {
        window.clearTimeout(avatarChangeWaveTimerRef.current);
        avatarChangeWaveTimerRef.current = null;
      }
      if (transitionTimerRef.current != null) {
        window.clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
      if (transitionFrameRef.current != null) {
        window.cancelAnimationFrame(transitionFrameRef.current);
        transitionFrameRef.current = null;
      }
    };
  }, []);

  const layerEntries = useMemo(() => {
    const orderedPaths = [
      currentPath,
      outgoingPath,
      ...preloadAvatars.map((avatar) => avatar.vrmPath),
    ];
    const seen = new Set<string>();
    return orderedPaths.flatMap((path) => {
      if (!path || seen.has(path)) return [];
      seen.add(path);
      return [
        {
          vrmPath: path,
          fallbackPreviewUrl:
            fallbackPreviewByPathRef.current.get(path) ?? fallbackPreviewUrl,
        },
      ];
    });
  }, [currentPath, fallbackPreviewUrl, outgoingPath, preloadAvatars]);

  return (
    <div className="fixed inset-0 z-0 overflow-hidden bg-[#030711]">
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 50% 18%, rgba(44, 188, 255, 0.18) 0%, rgba(44, 188, 255, 0.04) 24%, rgba(3, 7, 17, 0) 52%), linear-gradient(180deg, #06101d 0%, #040913 48%, #02050c 100%)",
          }}
        />
        <div
          className="absolute inset-x-[-14%] bottom-[-24%] h-[74%] opacity-70"
          style={{
            transform: "perspective(1200px) rotateX(80deg)",
            transformOrigin: "center bottom",
            backgroundImage:
              "linear-gradient(rgba(118, 232, 255, 0.2) 1px, transparent 1px), linear-gradient(90deg, rgba(118, 232, 255, 0.18) 1px, transparent 1px)",
            backgroundSize: "68px 68px",
            boxShadow: "0 -24px 90px rgba(40, 184, 255, 0.14)",
          }}
        />
        <div
          className="absolute inset-x-0 top-[39%] h-px opacity-55"
          style={{
            background:
              "linear-gradient(90deg, transparent 0%, rgba(118, 232, 255, 0.12) 18%, rgba(118, 232, 255, 0.58) 50%, rgba(118, 232, 255, 0.12) 82%, transparent 100%)",
            boxShadow: "0 0 20px rgba(118, 232, 255, 0.18)",
          }}
        />
      </div>
      <div
        className="absolute inset-0 z-10"
        style={{
          opacity: 1,
          transition: "opacity 400ms ease",
        }}
      >
        {layerEntries.map((entry) => {
          const isCurrent = entry.vrmPath === currentPath;
          const isOutgoing = entry.vrmPath === outgoingPath;
          const visible = isCurrent || isOutgoing;
          return (
            <VrmStageLayer
              key={entry.vrmPath}
              active={active && visible}
              visible={visible}
              opacity={isOutgoing ? outgoingOpacity : 1}
              zIndex={isCurrent ? 2 : isOutgoing ? 1 : 0}
              vrmPath={entry.vrmPath}
              worldUrl={worldUrl}
              fallbackPreviewUrl={entry.fallbackPreviewUrl}
              cameraProfile={cameraProfile}
              initialCompanionZoomNormalized={initialCompanionZoomNormalized}
              onEngineReady={handleLayerEngineReady}
              onRevealStart={handleRevealStart}
              t={t}
            />
          );
        })}
      </div>
    </div>
  );
});
