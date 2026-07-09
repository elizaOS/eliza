/**
 * BackgroundView — the "Background" view.
 *
 * A minimal, wordless shell around the shared Appearance settings background
 * controls. The view stays transparent so the live wallpaper shows behind the
 * controls and updates the instant a choice is made — the same background Home,
 * Launcher, Settings, and this route share.
 */

import { BackgroundSettingsControls } from "../settings/BackgroundSettingsControls";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

export function BackgroundView() {
  return (
    <ShellViewAgentSurface viewId="background">
      {/* This view renders WITHOUT a shell scroll wrapper (the `background` tab
          is full-bleed on the transparent shell), so it owns its own bottom
          clearance: the floating-composer + bottom-nav + safe-area stack, plus
          the standard `--view-pad-top` gutter. No magic `pb-28`. */}
      <div className="eliza-continuous-chat-scroll absolute inset-x-0 top-0 bottom-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-continuous-chat-clearance,5.25rem)+1rem)] flex flex-col items-center overflow-y-auto px-4 pt-[var(--view-pad-top)] pb-4 pe-[var(--eliza-continuous-chat-side-clearance,0px)]">
        <h1 className="sr-only">Background</h1>
        <BackgroundSettingsControls />
      </div>
    </ShellViewAgentSurface>
  );
}
