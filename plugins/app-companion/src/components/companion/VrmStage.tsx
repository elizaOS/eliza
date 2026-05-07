import {
  APP_EMOTE_EVENT,
  type AppEmoteEventDetail,
  type CompanionHalfFramerateMode,
  type CompanionVrmPowerMode,
  resolveAppAssetUrl,
  STOP_EMOTE_EVENT,
  type TranslateFn,
  useRenderGuard,
} from "@elizaos/app-core";
import {
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  CameraProfile,
  VrmEngine,
  VrmEngineState,
} from "../avatar/VrmEngine";
import { VrmViewer, type VrmViewerProps } from "../avatar/VrmViewer";

const AVATAR_CHANGE_WAVE_DELAY_MS = 650;
const AVATAR_CHANGE_WAVE_EMOTE: AppEmoteEventDetail = {
  emoteId: "wave",
  path: "/animations/emotes/greeting.fbx",
  duration: 2.5,
  loop: false,
  showOverlay: false,
};

/**
 * VrmStage — single persistent VRM engine that swaps only the character model
 * when `vrmPath` changes. The mathematical environment stays
 * continuously rendered, completely decoupled from character selection.
 */
export const VrmStage = memo(function VrmStage({
  active = true,
  vrmPath,
  environmentTheme,
  fallbackPreviewUrl,
  cameraProfile = "companion",
  initialCompanionZoomNormalized,
  onEngineReady,
  onRevealStart,
  playWaveOnAvatarChange = false,
  onLayerEngineReady: _onLayerEngineReady,
  companionVrmPowerMode = "balanced",
  companionHalfFramerateMode = "when_saving_power",
  companionAnimateWhenHidden = false,
  viewerComponent: ViewerComponent = VrmViewer,
  t,
}: {
  active?: boolean;
  vrmPath: string;
  environmentTheme?: "light" | "dark";
  fallbackPreviewUrl: string;
  cameraProfile?: CameraProfile;
  initialCompanionZoomNormalized?: number;
  onEngineReady?: (engine: VrmEngine) => void;
  onLayerEngineReady?: (vrmPath: string, engine: VrmEngine) => void;
  onRevealStart?: () => void;
  playWaveOnAvatarChange?: boolean;
  companionVrmPowerMode?: CompanionVrmPowerMode;
  companionHalfFramerateMode?: CompanionHalfFramerateMode;
  companionAnimateWhenHidden?: boolean;
  viewerComponent?: (props: VrmViewerProps) => ReactElement;
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
  const [, setLoaderFading] = useState(false);
  const [loaderHidden, setLoaderHidden] = useState(false);
  const loaderFadingStartedRef = useRef(false);
  /** After the first successful VRM load, suppress the loader on subsequent swaps. */
  const hasLoadedFirstVrmRef = useRef(false);

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
        swayAmplitude: 0.04,
        bobAmplitude: 0.022,
        rotationAmplitude: 0.012,
        speed: 0.42,
      });
      engine.setPointerParallaxEnabled(false);
      if (typeof initialCompanionZoomNormalized === "number") {
        engine.setCompanionZoomNormalized(initialCompanionZoomNormalized);
      }
      onEngineReady?.(engine);
    },
    [initialCompanionZoomNormalized, onEngineReady],
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
    <div
      data-testid="companion-vrm-stage"
      data-theme={environmentTheme}
      className={`fixed inset-0 z-0 overflow-hidden ${environmentTheme === "dark" ? "bg-[#08060e]" : "bg-[#f5f5f5]"}`}
    >
      {/* Static CSS fallback — themed construct with faint receding grid */}
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute inset-0"
          style={{
            background:
              environmentTheme === "dark"
                ? "radial-gradient(circle at 50% 40%, rgba(80, 20, 140, 0.18) 0%, transparent 60%), linear-gradient(180deg, #08060e 0%, #0c0a14 100%)"
                : "radial-gradient(circle at 50% 40%, rgba(180, 200, 220, 0.12) 0%, transparent 60%), linear-gradient(180deg, #f5f5f5 0%, #efefef 100%)",
          }}
        />
        <div
          className={`absolute inset-x-[-14%] bottom-[-24%] h-[74%] ${environmentTheme === "dark" ? "opacity-50" : "opacity-30"}`}
          style={{
            transform: "perspective(1200px) rotateX(80deg)",
            transformOrigin: "center bottom",
            backgroundImage:
              environmentTheme === "dark"
                ? "linear-gradient(rgba(80, 20, 160, 0.45) 1px, transparent 1px), linear-gradient(90deg, rgba(80, 20, 160, 0.4) 1px, transparent 1px)"
                : "linear-gradient(rgba(160, 170, 180, 0.25) 1px, transparent 1px), linear-gradient(90deg, rgba(160, 170, 180, 0.22) 1px, transparent 1px)",
            backgroundSize: "68px 68px",
          }}
        />
      </div>

      {/* Single persistent VrmViewer — world stays loaded, only character swaps */}
      <div className="absolute inset-0 z-10">
        <ViewerComponent
          active={active}
          vrmPath={vrmPath}
          environmentTheme={environmentTheme}
          cameraProfile={cameraProfile}
          companionVrmPowerMode={companionVrmPowerMode}
          companionHalfFramerateMode={companionHalfFramerateMode}
          companionAnimateWhenHidden={companionAnimateWhenHidden}
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

      {/* Subtle loading indicator while VRM downloads on first load */}
      {!vrmLoaded && !showVrmFallback && !loaderHidden && (
        <div className="absolute inset-x-0 bottom-[18%] z-20 flex flex-col items-center gap-2 pointer-events-none">
          <div className="h-1 w-32 overflow-hidden rounded-full bg-black/8">
            <div
              className="h-full rounded-full bg-status-info/50 transition-all duration-300 ease-out"
              style={{
                width:
                  loadingProgress !== undefined
                    ? `${Math.max(loadingProgress, 5)}%`
                    : "15%",
                ...(loadingProgress === undefined
                  ? {
                      animation:
                        "vrm-loader-pulse 1.8s ease-in-out infinite alternate",
                    }
                  : {}),
              }}
            />
          </div>
          <style>{`@keyframes vrm-loader-pulse { from { width: 15%; opacity: 0.5; } to { width: 60%; opacity: 1; } }`}</style>
        </div>
      )}
    </div>
  );
});
