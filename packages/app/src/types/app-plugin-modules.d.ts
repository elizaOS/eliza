import type {
  AppBlockerSettingsCardProps,
  WebsiteBlockerSettingsCardProps,
} from "@elizaos/shared";
import type {
  CodingAgentTasksPanelProps,
  CompanionInferenceNotice,
  CompanionSceneStatus,
  CompanionShellComponentProps,
  ResolveCompanionInferenceNoticeArgs,
  StewardApprovalQueueProps,
  StewardLogoProps,
  StewardTransactionHistoryProps,
  VincentStateHookArgs,
  VincentStateHookResult,
} from "@elizaos/ui";
import type { ComponentType } from "react";

type EmptyComponent = ComponentType<Record<string, never>>;

declare module "@elizaos/app-core" {
  export interface BuildOnboardingConnectionArgs {
    onboardingServerTarget?:
      | ""
      | "local"
      | "remote"
      | "elizacloud"
      | "elizacloud-hybrid";
    onboardingCloudApiKey: string;
    onboardingProvider: string;
    onboardingApiKey: string;
    omitRuntimeProvider?: boolean;
    onboardingVoiceProvider: string;
    onboardingVoiceApiKey: string;
    onboardingPrimaryModel: string;
    onboardingOpenRouterModel: string;
    onboardingRemoteConnected: boolean;
    onboardingRemoteApiBase: string;
    onboardingRemoteToken: string;
    onboardingNanoModel?: string;
    onboardingSmallModel?: string;
    onboardingMediumModel?: string;
    onboardingLargeModel?: string;
    onboardingMegaModel?: string;
    onboardingResponseHandlerModel?: string;
    onboardingActionPlannerModel?: string;
    onboardingFeatureTelegram?: boolean;
    onboardingFeatureDiscord?: boolean;
    onboardingFeaturePhone?: boolean;
    onboardingFeatureCrypto?: boolean;
    onboardingFeatureBrowser?: boolean;
    onboardingFeatureComputerUse?: boolean;
    onboardingUseLocalEmbeddings?: boolean;
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

declare module "@elizaos/app-companion" {
  export const CompanionShell: ComponentType<CompanionShellComponentProps>;
  export const GlobalEmoteOverlay: EmptyComponent;
  export const InferenceCloudAlertButton: ComponentType<{
    notice: CompanionInferenceNotice;
    onClick: () => void;
    onPointerDown?: (...args: unknown[]) => unknown;
  }>;
  export const THREE: unknown;
  export function createVectorBrowserRenderer(
    ...args: unknown[]
  ): Promise<unknown>;
  export function registerCompanionApp(): void;
  export function resolveCompanionInferenceNotice(
    args: ResolveCompanionInferenceNoticeArgs,
  ): CompanionInferenceNotice | null;
  export function useCompanionSceneStatus(): CompanionSceneStatus;
}

declare module "@elizaos/plugin-companion" {
  export * from "@elizaos/app-companion";
}

declare module "@elizaos/app-lifeops" {
  export const LifeOpsPageView: EmptyComponent;
  export const LifeOpsBrowserSetupPanel: EmptyComponent;
  export const LifeOpsActivitySignalsEffect: EmptyComponent;
  export const AppBlockerSettingsCard: ComponentType<AppBlockerSettingsCardProps>;
  export const WebsiteBlockerSettingsCard: ComponentType<WebsiteBlockerSettingsCardProps>;
  export function dispatchQueuedLifeOpsGithubCallbackFromUrl(url: string): void;
}

declare module "@elizaos/plugin-lifeops" {
  export * from "@elizaos/app-lifeops";
}

declare module "@elizaos/app-phone" {
  export const PhoneCompanionApp: EmptyComponent;
}

declare module "@elizaos/plugin-phone" {
  export * from "@elizaos/app-phone";
}

declare module "@elizaos/app-steward" {
  export const StewardLogo: ComponentType<StewardLogoProps>;
  export const ApprovalQueue: ComponentType<StewardApprovalQueueProps>;
  export const TransactionHistory: ComponentType<StewardTransactionHistoryProps>;
}

declare module "@elizaos/plugin-steward-app" {
  export * from "@elizaos/app-steward";
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
  import type { FineTuningViewProps } from "@elizaos/ui";

  export const FineTuningView: ComponentType<FineTuningViewProps>;
}

declare module "@elizaos/plugin-training" {
  export * from "@elizaos/app-training";
}

declare module "@elizaos/app-vincent" {
  export function useVincentState(
    args: VincentStateHookArgs,
  ): VincentStateHookResult;
}

declare module "@elizaos/plugin-vincent" {
  export * from "@elizaos/app-vincent";
}

declare module "@elizaos/app-babylon" {
  export {};
}

declare module "@elizaos/app-scape" {
  export {};
}

declare module "@elizaos/app-hyperscape" {
  export {};
}

declare module "@elizaos/app-2004scape" {
  export {};
}

declare module "@elizaos/app-defense-of-the-agents" {
  export {};
}

declare module "@elizaos/app-clawville" {
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
