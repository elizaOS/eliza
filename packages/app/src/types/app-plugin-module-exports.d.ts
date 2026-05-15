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

declare module "@elizaos/plugin-phone" {
  export const PhoneCompanionApp: import("react").ComponentType<
    Record<string, never>
  >;
}

declare module "@elizaos/plugin-steward-app" {
  export const ApprovalQueue: import("react").ComponentType<
    import("@elizaos/ui").StewardApprovalQueueProps
  >;
  export const StewardLogo: import("react").ComponentType<
    import("@elizaos/ui").StewardLogoProps
  >;
  export const TransactionHistory: import("react").ComponentType<
    import("@elizaos/ui").StewardTransactionHistoryProps
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

declare module "@elizaos/plugin-vincent" {
  export function useVincentState(
    args: import("@elizaos/ui").VincentStateHookArgs,
  ): import("@elizaos/ui").VincentStateHookResult;
}
