/** Declares renderer plugin surfaces while retaining exact types for shared host exports. */
import type {
  AppBlockerSettingsCardProps,
  WebsiteBlockerSettingsCardProps,
} from "@elizaos/shared";
import type { CodingAgentTasksPanelProps } from "@elizaos/ui/config";
import type { ComponentType } from "react";
import type { sanitizeCompletionRelay as SanitizeCompletionRelay } from "../../../../plugins/plugin-agent-orchestrator/src/services/transcript-sanitizer";

type EmptyComponent = ComponentType<Record<string, never>>;

declare module "@elizaos/plugin-personal-assistant" {
  export const AppBlockerSettingsCard: ComponentType<AppBlockerSettingsCardProps>;
  export const WebsiteBlockerSettingsCard: ComponentType<WebsiteBlockerSettingsCardProps>;
}

declare module "@elizaos/plugin-blocker" {
  // Renderer builds alias this bare specifier to plugin-blocker's
  // src/register.ts — a side-effect-only module with NO exports (see
  // resolveAppPluginBrowserEntry in vite.config.ts). Keep this declaration
  // empty so tsc rejects any attempt to consume engine exports through the
  // root specifier; the native-backend registrars are typed for real via the
  // `@elizaos/plugin-blocker/native` tsconfig path.
  export {};
}

declare module "@elizaos/app-phone" {
  export const PhoneCompanionApp: EmptyComponent;
}

declare module "@elizaos/plugin-native-phone" {
  export * from "@elizaos/app-phone";
}

declare module "@elizaos/app-task-coordinator" {
  export const CodingAgentControlChip: EmptyComponent;
  export const CodingAgentSettingsSection: EmptyComponent;
  export const CodingAgentTasksPanel: ComponentType<CodingAgentTasksPanelProps>;
}

declare module "@elizaos/plugin-agent-orchestrator" {
  export const sanitizeCompletionRelay: typeof SanitizeCompletionRelay;
  export * from "@elizaos/app-task-coordinator";
}

declare module "@elizaos/app-feed" {
  export {};
}

declare module "@elizaos/app-trajectory-logger" {
  export {};
}

declare module "@elizaos/app-wallet" {
  export {};
}

declare module "@elizaos/app-contacts/register" {
  export {};
}

declare module "@elizaos/app-device-settings/register" {
  export {};
}

declare module "@elizaos/app-messages/register" {
  export {};
}

declare module "@elizaos/app-phone/register" {
  export {};
}

declare module "@elizaos/app-wifi/register" {
  export {};
}
