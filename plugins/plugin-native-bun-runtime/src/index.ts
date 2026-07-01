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
