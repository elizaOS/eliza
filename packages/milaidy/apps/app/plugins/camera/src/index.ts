import { registerPlugin, Capacitor } from "@capacitor/core";

import type { CameraPlugin } from "./definitions";

const electronModulePath = "../electron/src/index";

const Camera = registerPlugin<CameraPlugin>("MilaidyCamera", {
  web: () => import("./web").then((m) => new m.CameraWeb()),
  electron: () => {
    // Use Electron-specific implementation for macOS/Windows/Linux
    if (Capacitor.getPlatform() === "electron") {
      return import(/* @vite-ignore */ electronModulePath).then((m: { Camera: CameraPlugin }) => m.Camera);
    }
    // Fallback to web implementation
    return import("./web").then((m) => new m.CameraWeb());
  },
});

export * from "./definitions";
export { Camera };
