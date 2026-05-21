import type * as React from "react";

import { CloudVideoBackground } from "../../backgrounds/CloudVideoBackground";
import { useShellControllerContext } from "../shell/ShellControllerContext";
import { VoiceWaveform } from "../voice/VoiceWaveform";

/**
 * Default landing surface — the "home" assistant view.
 *
 * Renders the clouds backdrop with a centered voice-avatar waveform as the
 * assistant's presence. The bottom-center overlay pill (HomePill +
 * AssistantOverlay + ChatSurface) is mounted globally by
 * `ShellFoundationMount` in App.tsx and docks over this view; the waveform
 * mode is driven by the shared shell controller phase.
 */
export function HomeView(): React.JSX.Element {
  const controller = useShellControllerContext();
  const mode = controller?.waveformMode ?? "idle";

  return (
    <CloudVideoBackground
      speed="8x"
      basePath="/clouds"
      poster="/clouds/poster-960.jpg"
      scrim={0.08}
      style={{ height: "100%" }}
    >
      <div
        data-testid="home-view"
        className="flex h-full w-full flex-col items-center justify-center"
      >
        <VoiceWaveform mode={mode} size={240} />
      </div>
    </CloudVideoBackground>
  );
}
