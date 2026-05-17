import { type DeploymentTargetConfig, type LinkedAccountFlagsConfig, type OnboardingCredentialInputs, type ServiceRoutingConfig } from "@elizaos/shared";
import { type OnboardingServerTarget } from "./server-target";
export interface BuildOnboardingConnectionArgs {
    onboardingServerTarget?: OnboardingServerTarget;
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
/** Feature selections from the onboarding features step. */
export interface OnboardingFeatureSetup {
    connectors: {
        telegram?: {
            managed: boolean;
        };
        discord?: {
            managed: boolean;
        };
    };
    capabilities: {
        crypto?: boolean;
        browser?: boolean;
        computeruse?: boolean;
    };
}
export interface BuildOnboardingRuntimeConfigResult {
    deploymentTarget: DeploymentTargetConfig;
    linkedAccounts: LinkedAccountFlagsConfig | undefined;
    serviceRouting: ServiceRoutingConfig | undefined;
    credentialInputs: OnboardingCredentialInputs | undefined;
    needsProviderSetup: boolean;
    featureSetup: OnboardingFeatureSetup | undefined;
}
export declare function buildOnboardingRuntimeConfig(args: BuildOnboardingConnectionArgs): BuildOnboardingRuntimeConfigResult;
//# sourceMappingURL=onboarding-config.d.ts.map