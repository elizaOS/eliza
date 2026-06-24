/**
 * BackgroundView — the "Background" view.
 *
 * A minimal, wordless shell around the shared Appearance settings background
 * controls. The view stays transparent so the live wallpaper shows behind the
 * controls and updates the instant a choice is made — the same background Home,
 * Springboard, Settings, and this route share.
 */

import { BackgroundSettingsControls } from "../settings/BackgroundSettingsControls";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

export function BackgroundView() {
  return (
    <ShellViewAgentSurface viewId="background">
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-4 pb-28 pt-6">
        <h1 className="sr-only">Background</h1>
        <BackgroundSettingsControls />
      </div>
    </ShellViewAgentSurface>
  );
}
