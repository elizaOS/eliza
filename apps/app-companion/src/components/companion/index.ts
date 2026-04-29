/**
 * Companion / 3D avatar components.
 *
 * Opt in to the three.js-based stack via `@elizaos/app-companion` / this
 * package’s UI entry — not the generic `@elizaos/app-core/components`
 * avatar rendering stack (~850 KB+). Consumers that don't need 3D
 * companions can skip this entry point entirely.
 */

export * from "../avatar/VrmEngine";
export * from "../avatar/VrmViewer";
export * from "../chat/ChatAvatar";
export * from "./CompanionAppView";
export * from "./CompanionHeader";
export * from "./CompanionSceneHost";
export * from "./CompanionSettingsPanel";
export * from "./CompanionShell";
export * from "./CompanionView";
export * from "./companion-scene-status-context";
export * from "./companion-shell-styles";
export * from "./EmotePicker";
export * from "./GlobalEmoteOverlay";
export * from "./InferenceCloudAlertButton";
export * from "./resolve-companion-inference-notice";
export * from "./scene-overlay-bridge";
export { useSharedCompanionScene } from "./shared-companion-scene-context";
export * from "./VrmStage";
export * from "./walletUtils";
