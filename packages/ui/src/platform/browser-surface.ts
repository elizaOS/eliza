import { Capacitor } from "@capacitor/core";

/** Renderer implementation hint shared by text and voice; never authority. */
export function getClientBrowserSurface(): "native" | undefined {
  return Capacitor.isNativePlatform() ? "native" : undefined;
}
