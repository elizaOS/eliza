declare module "@elizaos/app-phone" {
  export const PhoneCompanionApp: import("react").ComponentType<
    Record<string, never>
  >;
}

declare module "@elizaos/app-steward" {
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

declare module "@elizaos/app-task-coordinator" {
  export const CodingAgentControlChip: import("react").ComponentType<
    Record<string, never>
  >;
  export const CodingAgentSettingsSection: import("react").ComponentType<
    Record<string, never>
  >;
  export const CodingAgentTasksPanel: import("react").ComponentType<
    import("@elizaos/ui").CodingAgentTasksPanelProps
  >;
  export const PtyConsoleDrawer: import("react").ComponentType<
    import("@elizaos/ui").PtyConsoleDrawerProps
  >;
}

declare module "@elizaos/app-training" {
  export const FineTuningView: import("react").ComponentType<
    import("@elizaos/ui").FineTuningViewProps
  >;
}

declare module "@elizaos/app-vincent" {
  export function useVincentState(
    args: import("@elizaos/ui").VincentStateHookArgs,
  ): import("@elizaos/ui").VincentStateHookResult;
}
