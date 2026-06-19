import {
  registerTrayIcon as electrobunRegister,
  type TrayHandle,
  type TrayRegistrationOptions,
} from "./electrobun-tray";
import { registerTrayIcon as webRegister } from "./web-fallback";

interface WindowWithElectrobun {
  electrobun?: unknown;
}

function hasElectrobunRuntime(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return Boolean((window as unknown as WindowWithElectrobun).electrobun);
}

export function registerTrayIcon(
  options: TrayRegistrationOptions = {},
): TrayHandle {
  if (hasElectrobunRuntime()) {
    return electrobunRegister(options);
  }
  return webRegister(options);
}

export type { TrayHandle, TrayRegistrationOptions } from "./electrobun-tray";
