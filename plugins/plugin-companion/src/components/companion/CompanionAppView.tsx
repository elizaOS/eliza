import type { OverlayAppContext } from "@elizaos/ui/components/apps/overlay-app-api";
import { useRenderGuard } from "@elizaos/ui/hooks";
import { useApp } from "@elizaos/ui/state";
import { memo, useEffect } from "react";
import { CompanionSceneHost } from "./CompanionSceneHost";
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
  const { emotePickerOpen } = useApp();

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

      <div className="flex-1 grid grid-cols-[1fr_auto] gap-6 min-h-0 relative">
        <div className="w-full h-full" />
      </div>
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
