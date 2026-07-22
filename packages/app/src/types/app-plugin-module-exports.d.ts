declare module "@elizaos/plugin-personal-assistant" {
  export const AppBlockerSettingsCard: import("react").ComponentType<
    import("@elizaos/ui").AppBlockerSettingsCardProps
  >;
  export const WebsiteBlockerSettingsCard: import("react").ComponentType<
    import("@elizaos/ui").WebsiteBlockerSettingsCardProps
  >;
  export const LifeOpsActivitySignalsEffect: import("react").ComponentType<
    Record<string, never>
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
