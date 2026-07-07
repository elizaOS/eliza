/**
 * Capacitor entry point: registers the native surface bridge as
 * `"ElizaSurfaceManager"` — the exact jsName the renderer's
 * `capacitor-native-surface-shell.ts` looks up — with a lazily-loaded web
 * fallback that rejects every call (a web host has no native child surface).
 * Re-exports every type in `./definitions` as the plugin's public API surface.
 */
import { registerPlugin } from "@capacitor/core";

import type { ElizaSurfaceManagerPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.BrowserSurfaceWeb());

export const ElizaSurfaceManager = registerPlugin<ElizaSurfaceManagerPlugin>(
  "ElizaSurfaceManager",
  { web: loadWeb },
);
