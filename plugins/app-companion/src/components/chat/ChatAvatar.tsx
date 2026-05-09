import {
  APP_EMOTE_EVENT,
  type AppEmoteEventDetail,
  getVrmPreviewUrl,
  getVrmUrl,
  resolveAppAssetUrl,
  STOP_EMOTE_EVENT,
  useApp,
} from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import type { VrmEngine, VrmEngineState } from "../avatar/VrmEngine";
import { VrmViewer } from "../avatar/VrmViewer";

export type ChatAvatarProps = Record<string, never>;

export function ChatAvatar(_props: ChatAvatarProps) {
  const {
    selectedVrmIndex,
    customVrmUrl,
    companionVrmPowerMode,
    companionHalfFramerateMode,
    companionAnimateWhenHidden,
  } = useApp();

  // Resolve VRM path from selected index or custom upload
  const vrmPath =
    selectedVrmIndex === 0 && customVrmUrl
      ? customVrmUrl
      : getVrmUrl(selectedVrmIndex || 1);
  const fallbackPreviewUrl =
    selectedVrmIndex > 0
      ? getVrmPreviewUrl(selectedVrmIndex)
      : getVrmPreviewUrl(1);

  const vrmEngineRef = useRef<VrmEngine | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [vrmLoaded, setVrmLoaded] = useState(false);
  const [showFallback, setShowFallback] = useState(false);

  const avatarVisible = engineReady || vrmLoaded || showFallback;

  const handleEngineReady = useCallback((engine: VrmEngine) => {
    vrmEngineRef.current = engine;
    setEngineReady(true);
  }, []);

  const handleEngineState = useCallback((state: VrmEngineState) => {
    if (state.vrmLoaded) {
      setVrmLoaded(true);
      setShowFallback(false);
      return;
    }
    if (state.loadError) {
      setVrmLoaded(false);
      setShowFallback(true);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the loading UI when the requested VRM changes.
  useEffect(() => {
    setVrmLoaded(false);
    setShowFallback(false);
  }, [vrmPath]);

  useEffect(() => {
    if (!engineReady) return;
    const handler = (event: Event) => {
      const engine = vrmEngineRef.current;
      if (!engine) return;
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
  }, [engineReady]);

  // Listen for stop-emote events from the EmotePicker control panel.
  useEffect(() => {
    if (!engineReady) return;
    const handler = () => {
      vrmEngineRef.current?.stopEmote();
    };
    document.addEventListener(STOP_EMOTE_EVENT, handler);
    return () => document.removeEventListener(STOP_EMOTE_EVENT, handler);
  }, [engineReady]);

  return (
    <div className="relative h-full w-full">
      <div
        className="absolute inset-0"
        style={{
          opacity: avatarVisible ? 0.95 : 0,
          transition: "opacity 0.45s ease-in-out",
          background:
            "radial-gradient(circle at 50% 100%, rgba(255,255,255,0.08), transparent 60%)",
        }}
      >
        <div className="absolute inset-0 overflow-hidden">
          <div
            className="absolute inset-0"
            style={{
              opacity: vrmLoaded ? 1 : 0,
              transition: "opacity 0.45s ease",
              // Keep a stable full-body framing in the narrow chat sidebar.
              transform: "scale(1.02) translateY(1%)",
              transformOrigin: "50% 42%",
            }}
          >
            <VrmViewer
              vrmPath={vrmPath}
              interactive
              interactiveMode="orbitZoom"
              companionVrmPowerMode={companionVrmPowerMode}
              companionHalfFramerateMode={companionHalfFramerateMode}
              companionAnimateWhenHidden={companionAnimateWhenHidden}
              onEngineReady={handleEngineReady}
              onEngineState={handleEngineState}
            />
          </div>

          {showFallback && !vrmLoaded && (
            <img
              src={fallbackPreviewUrl}
              alt="avatar preview"
              className="absolute left-1/2 -translate-x-1/2 bottom-[-2%] h-[122%] object-contain opacity-90"
            />
          )}

          {!vrmLoaded && !showFallback && (
            <div className="flex h-full w-full items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent opacity-40" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
