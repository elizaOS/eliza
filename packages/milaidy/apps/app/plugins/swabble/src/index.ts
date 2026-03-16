import { registerPlugin, Capacitor } from "@capacitor/core";

import type { SwabblePlugin } from "./definitions";

const electronModulePath = "../electron/src/index";

const Swabble = registerPlugin<SwabblePlugin>("Swabble", {
  web: () => import("./web").then((m) => new m.SwabbleWeb()),
  electron: () => {
    // Use Electron-specific implementation for macOS/Windows/Linux
    if (Capacitor.getPlatform() === "electron") {
      return import(/* @vite-ignore */ electronModulePath).then((m: { Swabble: SwabblePlugin }) => m.Swabble);
    }
    // Fallback to web implementation
    return import("./web").then((m) => new m.SwabbleWeb());
  },
});

export * from "./definitions";
export { Swabble };
