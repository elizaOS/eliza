/**
 * Hosts the unified background controls inside the Settings surface without
 * adding extra chrome that would hide the live wallpaper preview.
 */
import { BackgroundSettingsControls } from "./BackgroundSettingsControls";

export function BackgroundSettingsSection() {
  return (
    <div className="flex w-full justify-center">
      <BackgroundSettingsControls />
    </div>
  );
}
