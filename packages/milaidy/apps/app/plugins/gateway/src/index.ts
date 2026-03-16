import { registerPlugin, Capacitor } from "@capacitor/core";

import type { GatewayPlugin } from "./definitions";

// Electron path kept as a string to prevent tsc from resolving the file
// under a different rootDir. The actual path is resolved at runtime by the bundler.
const electronModulePath = "../electron/src/index";

const Gateway = registerPlugin<GatewayPlugin>("Gateway", {
  web: () => import("./web").then((m) => new m.GatewayWeb()),
  electron: () => {
    // Use Electron-specific implementation for macOS/Windows/Linux
    if (Capacitor.getPlatform() === "electron") {
      return import(/* @vite-ignore */ electronModulePath).then(
        (m: { Gateway: GatewayPlugin }) => m.Gateway
      );
    }
    // Fallback to web implementation
    return import("./web").then((m) => new m.GatewayWeb());
  },
});

export * from "./definitions";
export { Gateway };
