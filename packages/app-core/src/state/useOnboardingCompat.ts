import { useMemo } from "react";
import type { OnboardingServerTarget } from "../onboarding/server-target";
import type { OnboardingStateHook } from "./useOnboardingState";

export function useOnboardingCompat({
  dispatch,
  setConnectorToken,
  setDeferredTasks,
  setField,
  setRemoteStatus,
  state: { connectorTokens, remote },
}: OnboardingStateHook) {
  return useMemo(() => {
    const bindField =
      (field: string) =>
      (value: unknown): void => {
        setField(field, value);
      };
    const bindConnectorToken =
      (key: keyof typeof connectorTokens) =>
      (value: string): void => {
        setConnectorToken(key, value);
      };

    return {
      onboardingRemoteConnecting: remote.status === "connecting",
      onboardingRemoteError: remote.error,
      onboardingRemoteConnected: remote.status === "connected",
      onboardingTelegramToken: connectorTokens.telegramToken,
      onboardingDiscordToken: connectorTokens.discordToken,
      onboardingWhatsAppSessionPath: connectorTokens.whatsAppSessionPath,
      onboardingTwilioAccountSid: connectorTokens.twilioAccountSid,
      onboardingTwilioAuthToken: connectorTokens.twilioAuthToken,
      onboardingTwilioPhoneNumber: connectorTokens.twilioPhoneNumber,
      onboardingBlooioApiKey: connectorTokens.blooioApiKey,
      onboardingBlooioPhoneNumber: connectorTokens.blooioPhoneNumber,
      onboardingGithubToken: connectorTokens.githubToken,
      setOnboardingName: bindField("name") as (value: string) => void,
      setOnboardingOwnerName: bindField("ownerName") as (value: string) => void,
      setOnboardingStyle: bindField("style") as (value: string) => void,
      setOnboardingServerTarget: bindField("serverTarget") as (
        value: OnboardingServerTarget,
      ) => void,
      setOnboardingCloudApiKey: bindField("cloudApiKey") as (
        value: string,
      ) => void,
      setOnboardingSmallModel: bindField("smallModel") as (
        value: string,
      ) => void,
      setOnboardingLargeModel: bindField("largeModel") as (
        value: string,
      ) => void,
      setOnboardingProvider: bindField("provider") as (value: string) => void,
      setOnboardingApiKey: bindField("apiKey") as (value: string) => void,
      setOnboardingVoiceProvider: bindField("voiceProvider") as (
        value: string,
      ) => void,
      setOnboardingVoiceApiKey: bindField("voiceApiKey") as (
        value: string,
      ) => void,
      setOnboardingExistingInstallDetected: bindField(
        "existingInstallDetected",
      ) as (value: boolean) => void,
      setOnboardingRemoteApiBase: (value: string): void => {
        dispatch({ type: "SET_REMOTE_API_BASE", value });
      },
      setOnboardingRemoteToken: (value: string): void => {
        dispatch({ type: "SET_REMOTE_TOKEN", value });
      },
      setOnboardingRemoteConnecting: (value: boolean): void => {
        if (value) {
          setRemoteStatus("connecting");
          return;
        }
        if (remote.status === "connecting") {
          setRemoteStatus("idle");
        }
      },
      setOnboardingRemoteError: (value: string | null): void => {
        if (value) {
          setRemoteStatus("error", value);
          return;
        }
        if (remote.status === "error") {
          setRemoteStatus("idle");
        }
      },
      setOnboardingRemoteConnected: (value: boolean): void => {
        if (value) {
          setRemoteStatus("connected");
          return;
        }
        if (remote.status === "connected") {
          setRemoteStatus("idle");
        }
      },
      setOnboardingOpenRouterModel: bindField("openRouterModel") as (
        value: string,
      ) => void,
      setOnboardingPrimaryModel: bindField("primaryModel") as (
        value: string,
      ) => void,
      setOnboardingTelegramToken: bindConnectorToken("telegramToken"),
      setOnboardingDiscordToken: bindConnectorToken("discordToken"),
      setOnboardingWhatsAppSessionPath: bindConnectorToken(
        "whatsAppSessionPath",
      ),
      setOnboardingTwilioAccountSid: bindConnectorToken("twilioAccountSid"),
      setOnboardingTwilioAuthToken: bindConnectorToken("twilioAuthToken"),
      setOnboardingTwilioPhoneNumber: bindConnectorToken("twilioPhoneNumber"),
      setOnboardingBlooioApiKey: bindConnectorToken("blooioApiKey"),
      setOnboardingBlooioPhoneNumber: bindConnectorToken("blooioPhoneNumber"),
      setOnboardingGithubToken: bindConnectorToken("githubToken"),
      setOnboardingSubscriptionTab: bindField("subscriptionTab") as (
        value: "token" | "oauth",
      ) => void,
      setOnboardingElizaCloudTab: bindField("elizaCloudTab") as (
        value: "login" | "apikey",
      ) => void,
      setOnboardingSelectedChains: bindField("selectedChains") as (
        value: Set<string>,
      ) => void,
      setOnboardingRpcSelections: bindField("rpcSelections") as (
        value: Record<string, string>,
      ) => void,
      setOnboardingRpcKeys: bindField("rpcKeys") as (
        value: Record<string, string>,
      ) => void,
      setOnboardingAvatar: bindField("avatar") as (value: number) => void,
      setOnboardingFeatureTelegram: bindField("featureTelegram") as (
        value: boolean,
      ) => void,
      setOnboardingFeatureDiscord: bindField("featureDiscord") as (
        value: boolean,
      ) => void,
      setOnboardingFeaturePhone: bindField("featurePhone") as (
        value: boolean,
      ) => void,
      setOnboardingFeatureCrypto: bindField("featureCrypto") as (
        value: boolean,
      ) => void,
      setOnboardingFeatureBrowser: bindField("featureBrowser") as (
        value: boolean,
      ) => void,
      setOnboardingFeatureComputerUse: bindField("featureComputerUse") as (
        value: boolean,
      ) => void,
      setOnboardingFeatureOAuthPending: bindField("featureOAuthPending") as (
        value: string | null,
      ) => void,
      setOnboardingCloudProvisionedContainer: bindField(
        "cloudProvisionedContainer",
      ) as (value: boolean) => void,
      setPostOnboardingChecklistDismissed: (value: boolean): void => {
        dispatch({ type: "SET_POST_CHECKLIST_DISMISSED", value });
      },
      setOnboardingDeferredTasks: (tasks: string[]): void => {
        setDeferredTasks(tasks);
      },
    };
  }, [
    connectorTokens,
    dispatch,
    remote.error,
    remote.status,
    setConnectorToken,
    setDeferredTasks,
    setField,
    setRemoteStatus,
  ]);
}
