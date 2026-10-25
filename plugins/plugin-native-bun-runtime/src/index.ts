/**
 * TS host for the ElizaBunRuntime Capacitor plugin: re-exports the shared
 * type contract from `definitions.ts` and registers the plugin under the JS
 * name `ElizaBunRuntime`, wiring in the web fallback (`web.ts`) for browser
 * builds. Native builds resolve to the iOS/Android implementations through
 * Capacitor's own plugin registry rather than the `web` factory below.
 */

import { registerPlugin } from "@capacitor/core";
import type { ElizaBunRuntimePlugin } from "./definitions.js";

export * from "./definitions.js";

/**
 * The native plugin is registered under the JS name `ElizaBunRuntime`. The
 * Swift class in `ios/Sources/ElizaBunRuntimePlugin/ElizaBunRuntimePlugin.swift`
 * exposes the matching `jsName`.
 */
export const ElizaBunRuntime = registerPlugin<ElizaBunRuntimePlugin>(
  "ElizaBunRuntime",
  {
    web: () => import("./web.js").then((m) => new m.ElizaBunRuntimeWeb()),
  },
);
