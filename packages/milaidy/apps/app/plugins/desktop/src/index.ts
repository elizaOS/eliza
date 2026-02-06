import { registerPlugin, Capacitor } from "@capacitor/core";

import type { DesktopPlugin } from "./definitions";

const electronModulePath = "../electron/src/index";

const Desktop = registerPlugin<DesktopPlugin>("Desktop", {
  web: () => import("./web").then((m) => new m.DesktopWeb()),
  electron: () => {
    // Use Electron-specific implementation for macOS/Windows/Linux
    if (Capacitor.getPlatform() === "electron") {
      return import(/* @vite-ignore */ electronModulePath).then((m: { Desktop: DesktopPlugin }) => m.Desktop);
    }
    // Fallback to web implementation
    return import("./web").then((m) => new m.DesktopWeb());
  },
});

export * from "./definitions";
export { Desktop };
