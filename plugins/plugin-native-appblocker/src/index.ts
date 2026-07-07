/**
 * TS entry point for the `ElizaAppBlocker` Capacitor plugin: registers the
 * bridge to the native Android/iOS app-blocking engines and lazily loads
 * `AppBlockerWeb` when no native implementation is present. Re-exports the
 * shared `AppBlockerPlugin` types and the `NativeAppBlockerBackend` adapter
 * consumed by `@elizaos/plugin-blocker`.
 */
import { registerPlugin } from "@capacitor/core";

import type { AppBlockerPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () =>
  import("./web").then((module) => new module.AppBlockerWeb());

export const AppBlocker = registerPlugin<AppBlockerPlugin>("ElizaAppBlocker", {
  web: loadWeb,
});

export {
  createNativeAppBlockerBackend,
  type NativeAppBlockerBackend,
} from "./backend";
