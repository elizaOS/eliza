import { registerPlugin, Capacitor } from "@capacitor/core";

import type { LocationPlugin } from "./definitions";

const electronModulePath = "../electron/src/index";

const Location = registerPlugin<LocationPlugin>("MilaidyLocation", {
  web: () => import("./web").then((m) => new m.LocationWeb()),
  electron: () => {
    // Use Electron-specific implementation for macOS/Windows/Linux
    if (Capacitor.getPlatform() === "electron") {
      return import(/* @vite-ignore */ electronModulePath).then((m: { Location: LocationPlugin }) => m.Location);
    }
    // Fallback to web implementation
    return import("./web").then((m) => new m.LocationWeb());
  },
});

export * from "./definitions";
export { Location };
