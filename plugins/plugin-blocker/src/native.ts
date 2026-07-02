/**
 * `@elizaos/plugin-blocker/native` — the browser-safe native-backend
 * registration seam.
 *
 * Renderer builds alias the bare `@elizaos/plugin-blocker` specifier to
 * `src/register.ts` (a side-effect-only module that registers the Focus
 * terminal view — it has NO exports), so the WebView must import THIS entry
 * to wire the Capacitor blocker adapters into the engine registries at
 * startup (`packages/app/src/main.tsx` → `registerMobileBlockerBackends`).
 *
 * Everything reachable from here is browser-safe: the website-blocker
 * registry lives in its own node-free module, and the app-blocker engine only
 * touches `@capacitor/core`. Do not re-export anything from the hosts-file
 * engine or the services barrels — they drag `node:*` imports into the
 * renderer bundle (the browser-safety gate in `src/native.test.ts` enforces
 * this).
 */

export {
  getNativeAppBlockerBackend,
  type NativeAppBlockerBackend,
  registerNativeAppBlockerBackend,
} from "./services/app-blocker/engine.ts";
export {
  getNativeWebsiteBlockerBackend,
  type NativeWebsiteBlockerBackend,
  registerNativeWebsiteBlockerBackend,
} from "./services/website-blocker/native-backend.ts";
