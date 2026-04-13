/**
 * Companion / 3D avatar components.
 *
 * Import from `@elizaos/app-core/companion` instead of
 * `@elizaos/app-core/components` to opt-in to the three.js-based
 * avatar rendering stack (~850 KB+). Consumers that don't need 3D
 * companions can skip this entry point entirely.
 */

export * from "../avatar/VrmEngine";
export * from "../avatar/VrmViewer";
export * from "../chat/ChatAvatar";
export * from "./CompanionAppView";
export * from "./CompanionHeader";
export * from "./CompanionSceneHost";
export * from "./EmotePicker";
export * from "./GlobalEmoteOverlay";
export * from "./InferenceCloudAlertButton";
export * from "./companion-scene-status-context";
export * from "./resolve-companion-inference-notice";
export * from "./scene-overlay-bridge";
export * from "./shell-control-styles";
export * from "./companion-shell-styles";
export * from "./CompanionView";
export * from "./CompanionShell";
export * from "./walletUtils";
export { useSharedCompanionScene } from "./shared-companion-scene-context";
export * from "./VrmStage";
