import type { OverlayAppContext } from "@elizaos/ui/components/apps/overlay-app-api";
import { useRenderGuard } from "@elizaos/ui/hooks";
import { useAppSelector } from "@elizaos/ui/state";
import { memo, useEffect } from "react";
import { CompanionSceneHost } from "./CompanionSceneHost";
import { useCompanionSceneStatus } from "./companion-scene-status-context";
import { EmotePicker } from "./EmotePicker";

/**
 * Inner overlay rendered on top of the avatar scene. The companion now shows
 * just the avatar — no header / nav bar — so this only hosts the emote picker
 * overlay plus an Escape-to-exit affordance (the full-screen overlay app has no
 * visible chrome to close it otherwise).
 */
const CompanionOverlay = memo(function CompanionOverlay({
  exitToApps,
}: {
  exitToApps: () => void;
}) {
  useRenderGuard("CompanionAppView");
  const emotePickerOpen = useAppSelector((s) => s.emotePickerOpen);
  const { avatarReady } = useCompanionSceneStatus();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // While the emote picker is open it owns Escape (to close itself).
      if (event.key === "Escape" && !emotePickerOpen) {
        exitToApps();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [emotePickerOpen, exitToApps]);

  return (
    <div className="absolute inset-0 z-10 flex flex-col pointer-events-none">
      <EmotePicker />
      <button
        type="button"
        aria-label="Close companion"
        className="pointer-events-auto absolute right-4 top-4 z-20 grid h-10 w-10 place-items-center text-sm font-semibold text-white transition hover:bg-black/35"
        onClick={exitToApps}
        data-no-camera-drag="true"
      >
        x
      </button>

      <div
        className="absolute bottom-4 left-4 z-20 flex items-center gap-2 px-1 py-1"
        title={avatarReady ? "Avatar ready" : "Avatar loading"}
      >
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            avatarReady ? "bg-emerald-400" : "bg-amber-400"
          }`}
        />
        <span className="sr-only text-2xs font-semibold uppercase tracking-normal text-white/80">
          {avatarReady ? "Companion avatar ready" : "Companion avatar loading"}
        </span>
      </div>

      <div className="min-h-0 flex-1" />
    </div>
  );
});

/**
 * CompanionAppView — top-level overlay app component.
 *
 * Mounts CompanionSceneHost (which owns VrmStage → VrmViewer → VrmEngine).
 * Everything loads on mount, everything disposes on unmount.
 */
export function CompanionAppView(props: OverlayAppContext) {
  return (
    <div className="fixed inset-0 z-50 h-[100vh] w-full min-h-0 overflow-hidden supports-[height:100dvh]:h-[100dvh]">
      <CompanionSceneHost active>
        <CompanionOverlay exitToApps={props.exitToApps} />
      </CompanionSceneHost>
    </div>
  );
}
