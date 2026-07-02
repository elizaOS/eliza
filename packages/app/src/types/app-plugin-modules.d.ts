import type {
  AppBlockerSettingsCardProps,
  WebsiteBlockerSettingsCardProps,
} from "@elizaos/shared";
import type { CodingAgentTasksPanelProps } from "@elizaos/ui/config";
import type { ComponentType } from "react";

type EmptyComponent = ComponentType<Record<string, never>>;

declare module "@elizaos/app-core" {
  export const AppWindowRenderer: ComponentType<{ slug: string }>;
  export const DESKTOP_TRAY_MENU_ITEMS: ReadonlyArray<{
    id: string;
    label: string;
  }>;
  export const DesktopSurfaceNavigationRuntime: ComponentType<
    Record<string, never>
  >;
  export const DesktopTrayRuntime: ComponentType<Record<string, never>>;
  export const DetachedShellRoot: ComponentType<{ route: unknown }>;

  export interface BuildOnboardingConnectionArgs {
    firstRunRuntimeTarget?:
      | ""
      | "local"
      | "remote"
      | "elizacloud"
      | "elizacloud-hybrid";
    firstRunCloudApiKey: string;
    firstRunProvider: string;
    firstRunApiKey: string;
    omitRuntimeProvider?: boolean;
    firstRunVoiceProvider: string;
    firstRunVoiceApiKey: string;
    firstRunPrimaryModel: string;
    firstRunOpenRouterModel: string;
    firstRunRemoteConnected: boolean;
    firstRunRemoteApiBase: string;
    firstRunRemoteToken: string;
    firstRunNanoModel?: string;
    firstRunSmallModel?: string;
    firstRunMediumModel?: string;
    firstRunLargeModel?: string;
    firstRunMegaModel?: string;
    firstRunResponseHandlerModel?: string;
    firstRunActionPlannerModel?: string;
    firstRunFeatureTelegram?: boolean;
    firstRunFeatureDiscord?: boolean;
    firstRunFeaturePhone?: boolean;
    firstRunFeatureCrypto?: boolean;
    firstRunFeatureBrowser?: boolean;
    firstRunFeatureComputerUse?: boolean;
    firstRunUseLocalEmbeddings?: boolean;
  }

  export function buildOnboardingRuntimeConfig(
    args: BuildOnboardingConnectionArgs,
  ): {
    deploymentTarget: unknown;
    linkedAccounts: unknown;
    serviceRouting:
      | {
          tts?: {
            transport?: string;
            backend?: string;
          };
        }
      | undefined;
    credentialInputs: unknown;
    needsProviderSetup: boolean;
    featureSetup: unknown;
  };
}

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

declare module "@elizaos/plugin-phone" {
  export * from "@elizaos/app-phone";
}

declare module "@elizaos/app-task-coordinator" {
  export const CodingAgentControlChip: EmptyComponent;
  export const CodingAgentSettingsSection: EmptyComponent;
  export const CodingAgentTasksPanel: ComponentType<CodingAgentTasksPanelProps>;
}

declare module "@elizaos/plugin-task-coordinator" {
  export * from "@elizaos/app-task-coordinator";
}

declare module "@elizaos/app-training" {
  import type { FineTuningViewProps } from "@elizaos/ui/config";

  export const FineTuningView: ComponentType<FineTuningViewProps>;
}

declare module "@elizaos/plugin-training" {
  export * from "@elizaos/app-training";
}

declare module "@elizaos/app-feed" {
  export {};
}

declare module "@elizaos/app-trajectory-logger" {
  export {};
}

declare module "@elizaos/app-shopify" {
  export {};
}

declare module "@elizaos/app-hyperliquid" {
  export {};
}

declare module "@elizaos/app-polymarket" {
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
