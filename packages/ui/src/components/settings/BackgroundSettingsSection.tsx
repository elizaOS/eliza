/**
 * Hosts the unified background controls inside the Settings surface without
 * adding extra chrome that would hide the live wallpaper preview.
 */
import { BackgroundSettingsControls } from "./BackgroundSettingsControls";

/**
 * Background settings subview — the unified wallpaper picker (shader color,
 * image upload, cloud generate). Centered and chrome-light so the live
 * background shows through the Settings panel as choices apply instantly. The
 * same store drives Home, Launcher, chat, and every view's background.
 */
export function BackgroundSettingsSection() {
  return (
    <div className="flex w-full justify-center">
      <BackgroundSettingsControls />
    </div>
  );
}
