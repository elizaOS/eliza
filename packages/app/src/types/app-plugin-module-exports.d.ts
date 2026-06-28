declare module "@elizaos/plugin-companion" {
  export const CompanionShell: import("react").ComponentType<
    import("@elizaos/ui").CompanionShellComponentProps
  >;
  export const GlobalEmoteOverlay: import("react").ComponentType<
    Record<string, never>
  >;
  export const InferenceCloudAlertButton: import("react").ComponentType<{
    notice: import("@elizaos/ui").CompanionInferenceNotice;
    onClick: () => void;
    onPointerDown?: (...args: unknown[]) => unknown;
  }>;
  export const THREE: unknown;
  export function createVectorBrowserRenderer(): Promise<unknown>;
  export function registerCompanionApp(): void;
  export function resolveCompanionInferenceNotice(
    args: import("@elizaos/ui").ResolveCompanionInferenceNoticeArgs,
  ): import("@elizaos/ui").CompanionInferenceNotice | null;
  export function useCompanionSceneStatus(): import("@elizaos/ui").CompanionSceneStatus;
}

declare module "@elizaos/plugin-companion/components/companion/companion-app" {
  export function registerCompanionApp(): void;
}

declare module "@elizaos/plugin-companion/components/companion/companion-scene-status-context" {
  export function useCompanionSceneStatus(): import("@elizaos/ui").CompanionSceneStatus;
}

declare module "@elizaos/plugin-companion/components/companion/resolve-companion-inference-notice" {
  export function resolveCompanionInferenceNotice(
    args: import("@elizaos/ui").ResolveCompanionInferenceNoticeArgs,
  ): import("@elizaos/ui").CompanionInferenceNotice | null;
}

declare module "@elizaos/plugin-companion/components/companion/CompanionShell" {
  export const CompanionShell: import("react").ComponentType<
    import("@elizaos/ui").CompanionShellComponentProps
  >;
}

declare module "@elizaos/plugin-companion/components/companion/GlobalEmoteOverlay" {
  export const GlobalEmoteOverlay: import("react").ComponentType<
    Record<string, never>
  >;
}

declare module "@elizaos/plugin-companion/components/companion/InferenceCloudAlertButton" {
  export const InferenceCloudAlertButton: import("react").ComponentType<{
    notice: import("@elizaos/ui").CompanionInferenceNotice;
    onClick: () => void;
    onPointerDown?: (...args: unknown[]) => unknown;
  }>;
}

declare module "@elizaos/plugin-personal-assistant" {
  export const AppBlockerSettingsCard: import("react").ComponentType<
    import("@elizaos/ui").AppBlockerSettingsCardProps
  >;
  export const WebsiteBlockerSettingsCard: import("react").ComponentType<
    import("@elizaos/ui").WebsiteBlockerSettingsCardProps
  >;
  export const personalAssistantPlugin: unknown;
  export default personalAssistantPlugin;
}

declare module "@elizaos/plugin-phone" {
  export const PhoneCompanionApp: import("react").ComponentType<
    Record<string, never>
  >;
}

declare module "@elizaos/plugin-task-coordinator" {
  export const CodingAgentControlChip: import("react").ComponentType<
    Record<string, never>
  >;
  export const CodingAgentSettingsSection: import("react").ComponentType<
    Record<string, never>
  >;
  export const CodingAgentTasksPanel: import("react").ComponentType<
    import("@elizaos/ui").CodingAgentTasksPanelProps
  >;
}

declare module "@elizaos/plugin-training" {
  export const FineTuningView: import("react").ComponentType<
    import("@elizaos/ui").FineTuningViewProps
  >;
}
