import type { TrayHandle, TrayRegistrationOptions } from "./electrobun-tray";

export function registerTrayIcon(
  _options: TrayRegistrationOptions = {},
): TrayHandle {
  return {
    isAttached: false,
    dispose: () => undefined,
  };
}
