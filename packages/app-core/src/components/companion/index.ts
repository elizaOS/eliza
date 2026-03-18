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
export * from "../ChatAvatar";
export * from "../CompanionSceneHost";
export * from "../CompanionShell";
export * from "../CompanionView";
export * from "../companion-shell-styles";
export { useSharedCompanionScene } from "../shared-companion-scene-context";
export * from "../VrmStage";
