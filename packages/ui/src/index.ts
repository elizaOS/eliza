// Stylesheets live in `./styles.ts` (`@elizaos/ui/styles`) so the barrel can be
// imported by Node-side plugin loaders without forcing a CSS evaluation
// (Node refuses ".css" extensions). Renderers must opt-in explicitly.

export * from "./App";
export * from "./api";
export * from "./app-shell-components";
export * from "./app-shell-registry";
export * from "./bridge";
export * from "./character-catalog";
export * from "./chat";
export * from "./components";
export * from "./components/composites";
export * from "./components/composites/page-panel";
export * from "./components/pages/vector-browser-utils";
export * from "./components/primitives";
export * from "./config";
export * from "./content-packs";
export * from "./desktop-runtime";
export * from "./events";
export * from "./hooks";
export * from "./i18n";
export * from "./i18n/messages";
export * from "./layouts";
export * from "./lib/floating-layers";
export * from "./lib/utils";
export * from "./navigation";
export * from "./onboarding/mobile-runtime-mode";
export * from "./onboarding/pre-seed-local-runtime";
export * from "./onboarding-config";
export * from "./platform";
export * from "./providers";
export * from "./shell-params";
export * from "./slots/task-coordinator-slots";
export * from "./state";
export { computeStreamingDelta } from "./state";
export * from "./themes/apply-theme";
export * from "./types";
export * from "./utils";
export * from "./voice";
export * from "./widgets";
export * from "./widgets/registry-store";

// MILADY local-mode stubs: symbols that app-lifeops imports from
// `@elizaos/ui` but that don't exist in the source tree (the symbols
// only live in the test-stub file at
// `plugins/app-lifeops/test/stubs/ui.ts`). Provide noop runtime stubs
// so the renderer can statically link.
export function dispatchFocusConnector(): void {}
