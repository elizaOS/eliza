/**
 * Capacitor entry point: registers the native camera bridge as `"ElizaCamera"`,
 * falling back to `CameraWeb` (lazy-loaded to keep browser bundles free of the
 * native binding stubs) when no native implementation is present. Re-exports
 * every type in `./definitions` as the plugin's public API surface.
 */
import { registerPlugin } from "@capacitor/core";

import type { CameraPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.CameraWeb());

export const Camera = registerPlugin<CameraPlugin>("ElizaCamera", {
  web: loadWeb,
});
