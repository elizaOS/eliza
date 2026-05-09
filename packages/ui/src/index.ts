import "./styles/styles.css";
import "./styles/brand-gold.css";

export * from "./app-shell-registry";
export * from "./widgets/registry-store";
export * from "./widgets";
export * from "./app-shell-components";
export * from "./App";
export * from "./api";
export * from "./bridge";
// `capacitor-shell` is a side-effect-only module that registers Capacitor
// plugins on a Capacitor / mobile host. It MUST NOT be in the shared barrel
// because it pulls in @elizaos/capacitor-* packages that are not present
// outside Capacitor / Android builds. Host entries that need it must import
// it explicitly (`import "@elizaos/ui/capacitor-shell"` or similar).
// export * from "./capacitor-shell";
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
