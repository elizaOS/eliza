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
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AvatarLoader } from "./AvatarLoader";
import type {
  CameraProfile,
  VrmEngine,
  VrmEngineState,
} from "./avatar/VrmEngine";
import { VrmViewer } from "./avatar/VrmViewer";

type TranslateFn = (key: string) => string;

const AVATAR_CHANGE_WAVE_DELAY_MS = 650;
const AVATAR_CHANGE_WAVE_EMOTE: AppEmoteEventDetail = {
  emoteId: "wave",
  path: "/animations/emotes/waving-both-hands.glb",
  duration: 2.5,
  loop: false,
  showOverlay: false,
};

/** @deprecated No longer used — kept for API compatibility. */
export type VrmStageAvatarEntry = {
  vrmPath: string;
  fallbackPreviewUrl: string;
};

/**
 * VrmStage — single persistent VRM engine that swaps only the character model
 * when `vrmPath` changes. The world background (Gaussian splat) stays
 * continuously rendered, completely decoupled from character selection.
 */
export const VrmStage = memo(function VrmStage({
  active = true,
  vrmPath,
  worldUrl,
  fallbackPreviewUrl,
  cameraProfile = "companion",
  initialCompanionZoomNormalized,
  onEngineReady,
  onRevealStart,
  playWaveOnAvatarChange = false,
  // Kept in the type signature for backwards compat but ignored — the single
  // engine handles character swaps without preloading separate layers.
  preloadAvatars: _preloadAvatars = [],
  onLayerEngineReady: _onLayerEngineReady,
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

  const engineRef = useRef<VrmEngine | null>(null);
  const avatarChangeWaveTimerRef = useRef<number | null>(null);
  const hasMountedRef = useRef(false);
  const prevVrmPathRef = useRef(vrmPath);

  const [vrmLoaded, setVrmLoaded] = useState(false);
  const [showVrmFallback, setShowVrmFallback] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState<number | undefined>(
    undefined,
  );
  const [loaderFading, setLoaderFading] = useState(false);
  const [loaderHidden, setLoaderHidden] = useState(false);
  const loaderFadingStartedRef = useRef(false);
  /** After the first successful VRM load, suppress the loader on subsequent swaps. */
  const hasLoadedFirstVrmRef = useRef(false);

  const chatAvatarVoice = useChatAvatarVoiceState();

  /* ── Greeting wave ──────────────────────────────────────────────── */

  const playGreetingWave = useCallback((engine: VrmEngine | null) => {
    if (!engine) return;
    const resolvedPath = resolveAppAssetUrl(AVATAR_CHANGE_WAVE_EMOTE.path);
    void engine.playEmote(
      resolvedPath,
      AVATAR_CHANGE_WAVE_EMOTE.duration ?? 3,
      AVATAR_CHANGE_WAVE_EMOTE.loop === true,
    );
  }, []);

  const scheduleGreetingWave = useCallback(
    (engine: VrmEngine | null) => {
      if (!active || !playWaveOnAvatarChange || !engine) return;
      if (avatarChangeWaveTimerRef.current != null) {
        window.clearTimeout(avatarChangeWaveTimerRef.current);
      }
      avatarChangeWaveTimerRef.current = window.setTimeout(() => {
        playGreetingWave(engine);
        avatarChangeWaveTimerRef.current = null;
      }, AVATAR_CHANGE_WAVE_DELAY_MS);
    },
    [active, playGreetingWave, playWaveOnAvatarChange],
  );

  /* ── Engine callbacks ───────────────────────────────────────────── */

  const handleEngineReady = useCallback(
    (engine: VrmEngine) => {
      engineRef.current = engine;
      engine.setCameraAnimation({
        enabled: true,
        swayAmplitude: cameraProfile === "companion_close" ? 0.028 : 0.04,
        bobAmplitude: cameraProfile === "companion_close" ? 0.016 : 0.022,
        rotationAmplitude:
          cameraProfile === "companion_close" ? 0.008 : 0.012,
        speed: cameraProfile === "companion_close" ? 0.48 : 0.42,
      });
      engine.setPointerParallaxEnabled(false);
      if (typeof initialCompanionZoomNormalized === "number") {
        engine.setCompanionZoomNormalized(initialCompanionZoomNormalized);
      }
      onEngineReady?.(engine);
    },
    [cameraProfile, initialCompanionZoomNormalized, onEngineReady],
  );

  const handleEngineState = useCallback(
    (state: VrmEngineState) => {
      if (state.loadingProgress !== undefined) {
        setLoadingProgress(Math.round(state.loadingProgress * 100));
      }
      if (state.vrmLoaded) {
        setVrmLoaded(true);
        setShowVrmFallback(false);
        hasLoadedFirstVrmRef.current = true;
        if (!loaderFadingStartedRef.current) {
          loaderFadingStartedRef.current = true;
          setLoaderFading(true);
          setTimeout(() => setLoaderHidden(true), 800);
        }
        // Schedule greeting wave after VRM loads on avatar change
        if (hasMountedRef.current) {
          scheduleGreetingWave(engineRef.current);
        }
        return;
      }
      if (state.loadError) {
        setLoaderHidden(true);
        setVrmLoaded(false);
        setShowVrmFallback(true);
      }
    },
    [scheduleGreetingWave],
  );

  const handleRevealStart = useCallback(() => {
    onRevealStart?.();
  }, [onRevealStart]);

  /* ── Reset loading UI when avatar path changes ──────────────────── */

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset loader on avatar change
  useEffect(() => {
    if (vrmPath === prevVrmPathRef.current && hasMountedRef.current) return;
    prevVrmPathRef.current = vrmPath;
    if (hasMountedRef.current) {
      // Avatar changed — reset loading state but NOT the world.
      // After the first successful VRM load, keep the loader hidden so
      // subsequent character swaps feel instant (no flash of loading bar).
      if (!hasLoadedFirstVrmRef.current) {
        setVrmLoaded(false);
        setShowVrmFallback(false);
        setLoadingProgress(undefined);
        setLoaderFading(false);
        setLoaderHidden(false);
        loaderFadingStartedRef.current = false;
      }
    }
    hasMountedRef.current = true;
  }, [vrmPath]);

  /* ── Companion zoom ─────────────────────────────────────────────── */

  useEffect(() => {
    if (typeof initialCompanionZoomNormalized !== "number") return;
    engineRef.current?.setCompanionZoomNormalized(
      initialCompanionZoomNormalized,
    );
  }, [initialCompanionZoomNormalized]);

  /* ── Emote event listeners ──────────────────────────────────────── */

  useEffect(() => {
    const handler = (event: Event) => {
      const engine = engineRef.current;
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

  useEffect(() => {
    const handler = () => {
      engineRef.current?.stopEmote();
    };
    document.addEventListener(STOP_EMOTE_EVENT, handler);
    return () => document.removeEventListener(STOP_EMOTE_EVENT, handler);
  }, []);

  /* ── Cleanup ────────────────────────────────────────────────────── */

  useEffect(() => {
    return () => {
      if (avatarChangeWaveTimerRef.current != null) {
        window.clearTimeout(avatarChangeWaveTimerRef.current);
        avatarChangeWaveTimerRef.current = null;
      }
    };
  }, []);

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <div className="fixed inset-0 z-0 overflow-hidden bg-[#030711]">
      {/* Static CSS fallback background */}
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

      {/* Single persistent VrmViewer — world stays loaded, only character swaps */}
      <div className="absolute inset-0 z-10">
        <VrmViewer
          active={active}
          vrmPath={vrmPath}
          worldUrl={worldUrl}
          mouthOpen={chatAvatarVoice.mouthOpen}
          isSpeaking={chatAvatarVoice.isSpeaking}
          cameraProfile={cameraProfile}
          onEngineReady={handleEngineReady}
          onEngineState={handleEngineState}
          onRevealStart={handleRevealStart}
        />
      </div>

      {/* Fallback preview on VRM load error */}
      {showVrmFallback && !vrmLoaded && (
        <img
          src={fallbackPreviewUrl}
          alt={t("companion.avatarPreviewAlt")}
          className="absolute left-1/2 top-[52%] z-20 -translate-x-1/2 -translate-y-1/2 h-[90%] object-contain opacity-70"
        />
      )}

      {/* Loading spinner while VRM loads */}
      {!loaderHidden && !showVrmFallback && (
        <div className="absolute inset-0 z-20">
          <AvatarLoader progress={loadingProgress} fadingOut={loaderFading} />
        </div>
      )}
    </div>
  );
});
