import { registerPlugin, Capacitor } from "@capacitor/core";
import type { TalkModePlugin } from "./definitions";

const electronModulePath = "../electron/src/index";

const TalkMode = registerPlugin<TalkModePlugin>("TalkMode", {
  web: () => import("./web").then((m) => new m.TalkModeWeb()),
  electron: () => {
    // Use Electron-specific implementation for macOS/Windows/Linux
    if (Capacitor.getPlatform() === "electron") {
      return import(/* @vite-ignore */ electronModulePath).then((m: { TalkMode: TalkModePlugin }) => m.TalkMode);
    }
    // Fallback to web implementation
    return import("./web").then((m) => new m.TalkModeWeb());
  },
});

export * from "./definitions";
export { TalkMode };
