import { registerPlugin, Capacitor } from "@capacitor/core";

import type { ScreenCapturePlugin } from "./definitions";

const electronModulePath = "../electron/src/index";

const ScreenCapture = registerPlugin<ScreenCapturePlugin>("ScreenCapture", {
  web: () => import("./web").then((m) => new m.ScreenCaptureWeb()),
  electron: () => {
    // Use Electron-specific implementation for macOS/Windows/Linux
    if (Capacitor.getPlatform() === "electron") {
      return import(/* @vite-ignore */ electronModulePath).then((m: { ScreenCapture: ScreenCapturePlugin }) => m.ScreenCapture);
    }
    // Fallback to web implementation
    return import("./web").then((m) => new m.ScreenCaptureWeb());
  },
});

export * from "./definitions";
export { ScreenCapture };
