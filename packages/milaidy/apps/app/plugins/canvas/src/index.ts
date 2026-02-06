import { registerPlugin, Capacitor } from "@capacitor/core";

import type { CanvasPlugin } from "./definitions";

const electronModulePath = "../electron/src/index";

const Canvas = registerPlugin<CanvasPlugin>("MilaidyCanvas", {
  web: () => import("./web").then((m) => new m.CanvasWeb()),
  electron: () => {
    // Use Electron-specific implementation for macOS/Windows/Linux
    if (Capacitor.getPlatform() === "electron") {
      return import(/* @vite-ignore */ electronModulePath).then((m: { Canvas: CanvasPlugin }) => m.Canvas);
    }
    // Fallback to web implementation
    return import("./web").then((m) => new m.CanvasWeb());
  },
});

export * from "./definitions";
export { Canvas };
