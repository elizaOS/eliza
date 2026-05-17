/**
 * Onboarding callbacks — extracted from AppContext.
 *
 * Holds all the callback functions for the onboarding flow:
 * completeOnboarding, runOnboardingChatHandoff, handleOnboardingFinish,
 * advanceOnboarding / handleOnboardingNext, revertOnboarding /
 * handleOnboardingBack, handleOnboardingJumpToStep, goToOnboardingStep,
 * applyResetConnectionWizardToHostingStep, handleCloudOnboardingFinish,
 * handleOnboardingUseLocalBackend, handleOnboardingRemoteConnect,
 * and applyDetectedProviders.
 */
import { type RefObject } from "react";
import type { StylePreset, VoiceConfig } from "../api";
import { ElizaClient } from "../api/client-base";

type OnboardingClient = Pick<
  ElizaClient,
  | "getAuthStatus"
  | "getBaseUrl"
  | "getStatus"
  | "provisionCloudSandbox"
  | "setBaseUrl"
  | "setToken"
  | "startAgent"
  | "submitOnboarding"
  | "updateConfig"
>;

import { type scanProviderCredentials } from "../bridge";
import type { UiLanguage } from "../i18n";
import { type Tab } from "../navigation";
import { type OnboardingNextOptions } from "./internal";
import type {
  AppState,
  CompleteOnboardingOptions,
  OnboardingStep,
} from "./types";
import type { OnboardingStateHook } from "./useOnboardingState";
export declare function buildOnboardingStyleVoiceConfig(args: {
  style: StylePreset | undefined;
  voiceProvider: string;
  voiceApiKey: string;
  cloudTtsSelected: boolean;
}): VoiceConfig | null;
export declare function buildOnboardingFeatureSubmitPayload(args: {
  onboardingFeatureTelegram: boolean;
  onboardingFeatureDiscord: boolean;
  onboardingFeatureBrowser: boolean;
  onboardingFeatureComputerUse: boolean;
}): {
  connectors?: Record<
    string,
    {
      enabled: true;
      managed: true;
    }
  >;
  features?: Record<
    string,
    {
      enabled: true;
    }
  >;
};
export interface OnboardingCallbacksDeps {
  /** Full result of useOnboardingState — state + all dispatch helpers. */
  onboarding: OnboardingStateHook;
  setActiveOverlayApp: (appName: string | null) => void;
  /**
   * Compat setter functions that already wrap onboarding.setField / dispatch.
   * Passed in from AppContext so we don't duplicate them here.
   */
  setOnboardingStep: (step: OnboardingStep) => void;
  setOnboardingMode: (v: AppState["onboardingMode"]) => void;
  setOnboardingActiveGuide: (v: string | null) => void;
  addDeferredOnboardingTask: (task: string) => void;
  setOnboardingDetectedProviders: (
    v: AppState["onboardingDetectedProviders"],
  ) => void;
  setOnboardingServerTarget: (v: AppState["onboardingServerTarget"]) => void;
  setOnboardingCloudApiKey: (v: string) => void;
  setOnboardingProvider: (v: string) => void;
  setOnboardingApiKey: (v: string) => void;
  setOnboardingPrimaryModel: (v: string) => void;
  setOnboardingRemoteApiBase: (v: string) => void;
  setOnboardingRemoteToken: (v: string) => void;
  setOnboardingRemoteConnecting: (v: boolean) => void;
  setOnboardingRemoteError: (v: string | null) => void;
  setOnboardingRemoteConnected: (v: boolean) => void;
  setPostOnboardingChecklistDismissed: (v: boolean) => void;
  setBrowserEnabled?: (v: boolean) => void;
  setComputerUseEnabled?: (v: boolean) => void;
  setWalletEnabled?: (v: boolean) => void;
  /** Lifecycle / global */
  setOnboardingComplete: (v: boolean) => void;
  coordinatorOnboardingCompleteRef: RefObject<(() => void) | null>;
  initialTabSetRef: RefObject<boolean>;
  setTab: (tab: Tab) => void;
  defaultLandingTab: Tab;
  loadCharacter: () => Promise<void>;
  uiLanguage: UiLanguage;
  selectedVrmIndex: number;
  walletConfig: AppState["walletConfig"];
  elizaCloudConnected: boolean;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
  retryStartup: () => void;
  forceLocalBootstrapRef: RefObject<boolean>;
  client: OnboardingClient;
}
export declare function useOnboardingCallbacks(deps: OnboardingCallbacksDeps): {
  completeOnboarding: (
    landingTab?: Tab,
    options?: CompleteOnboardingOptions,
  ) => void;
  runOnboardingChatHandoff: (options?: OnboardingNextOptions) => Promise<void>;
  handleOnboardingFinish: (options?: OnboardingNextOptions) => Promise<void>;
  goToOnboardingStep: (step: OnboardingStep) => void;
  applyResetConnectionWizardToHostingStep: () => void;
  advanceOnboarding: (options?: OnboardingNextOptions) => Promise<void>;
  handleOnboardingNext: (options?: OnboardingNextOptions) => Promise<void>;
  revertOnboarding: () => void;
  handleOnboardingBack: () => void;
  handleOnboardingJumpToStep: (target: OnboardingStep) => void;
  handleOnboardingUseLocalBackend: () => void;
  handleOnboardingRemoteConnect: () => Promise<void>;
  handleCloudOnboardingFinish: () => Promise<void>;
  applyDetectedProviders: (
    detected: Awaited<ReturnType<typeof scanProviderCredentials>>,
  ) => void;
};
//# sourceMappingURL=useOnboardingCallbacks.d.ts.map
