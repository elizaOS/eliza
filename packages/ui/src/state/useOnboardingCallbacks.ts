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

import { Capacitor } from "@capacitor/core";
import { getDefaultStylePreset } from "@elizaos/shared";
import { type RefObject, useCallback } from "react";
import type { StylePreset } from "../api";
import { ElizaClient, type VoiceConfig } from "../api";

const ensureOnboardedAgentRunning = async (
  client: ElizaClient,
): Promise<void> => {
  try {
    const status = await client.getStatus();
    if (status?.state !== "running" && status?.state !== "starting") {
      await client.startAgent();
    }
  } catch {
    // Non-fatal: agent manager may not be ready yet. Onboarding will retry.
  }
};

type NativeAgentPlugin = {
  start?: () => Promise<unknown>;
};

async function startNativeAgentIfAvailable(): Promise<void> {
  try {
    const capacitorWithPlugins = Capacitor as typeof Capacitor & {
      Plugins?: Record<string, NativeAgentPlugin | undefined>;
    };
    const registeredAgent =
      capacitorWithPlugins.Plugins?.Agent ??
      Capacitor.registerPlugin<NativeAgentPlugin>("Agent");
    await registeredAgent.start?.();
  } catch {
    const agentPluginId = "@elizaos/capacitor-agent";
    const { Agent } = await import(/* @vite-ignore */ agentPluginId);
    await (Agent as NativeAgentPlugin | undefined)?.start?.();
  }
}

import { buildWalletRpcUpdateRequest } from "@elizaos/app-wallet/wallet-rpc";
import {
  getDesktopRuntimeMode,
  invokeDesktopBridgeRequest,
  type scanProviderCredentials,
} from "../bridge";
import { getBootConfig } from "../config/boot-config";
import type { UiLanguage } from "../i18n";
import { APPS_ENABLED, COMPANION_ENABLED, type Tab } from "../navigation";
import {
  canRevertOnboardingTo,
  getFlaminaTopicForOnboardingStep,
  getOnboardingStepIndex,
  resolveOnboardingNextStep,
  resolveOnboardingPreviousStep,
  shouldSkipConnectionStepsForCloudProvisionedContainer,
  shouldSkipFeaturesStep,
  shouldUseCloudOnboardingFastTrack,
} from "../onboarding/flow";
import { persistMobileRuntimeModeForServerTarget } from "../onboarding/mobile-runtime-mode";
import { isElizaCloudOnboardingTarget } from "../onboarding/server-target";
import { buildOnboardingRuntimeConfig } from "../onboarding-config";
import { PREMADE_VOICES } from "../voice/types";
import {
  clearPersistedActiveServer,
  clearPersistedOnboardingStep,
  createPersistedActiveServer,
  type OnboardingNextOptions,
  savePersistedActiveServer,
} from "./internal";
import type {
  AppState,
  CompleteOnboardingOptions,
  OnboardingStep,
} from "./types";
import type { OnboardingStateHook } from "./useOnboardingState";

// ── Helpers copied from AppContext (module-level, no React deps) ──────────

function isPrivateNetworkHost(host: string): boolean {
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return true;
  }
  return false;
}

function replaceNavigationPathForCompanionLaunch(): void {
  if (typeof window === "undefined") return;
  const path = "/apps/companion";
  try {
    if (window.location.protocol === "file:") {
      window.location.hash = path;
    } else {
      window.history.replaceState(
        null,
        "",
        `${path}${window.location.search}${window.location.hash}`,
      );
    }
  } catch {
    /* ignore — sandboxed iframe */
  }
}

function normalizeRemoteApiBaseInput(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new Error("Enter a backend address.");
  }
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed);
  const hostGuess = trimmed.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//, "");
  const guessedHost = hostGuess.split("/")[0]?.replace(/:\d+$/, "") ?? "";
  const defaultProtocol = isPrivateNetworkHost(guessedHost) ? "http" : "https";
  const candidate = hasScheme ? trimmed : `${defaultProtocol}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Enter a valid backend address.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Remote backends must use http:// or https://.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function resolveSelectedOnboardingStyle(args: {
  styles: readonly StylePreset[] | undefined;
  onboardingStyle: string;
  selectedVrmIndex: number;
  uiLanguage: UiLanguage;
}): StylePreset {
  const styles = args.styles ?? [];
  return (
    styles.find((style) => style.id === args.onboardingStyle) ??
    styles.find(
      (style) =>
        typeof style.avatarIndex === "number" &&
        style.avatarIndex === args.selectedVrmIndex,
    ) ??
    styles[0] ??
    getDefaultStylePreset(args.uiLanguage)
  );
}

export function buildOnboardingStyleVoiceConfig(args: {
  style: StylePreset | undefined;
  voiceProvider: string;
  voiceApiKey: string;
  cloudTtsSelected: boolean;
}): VoiceConfig | null {
  const { style, voiceProvider, voiceApiKey, cloudTtsSelected } = args;
  const voicePresetId = style?.voicePresetId?.trim();
  if (!voicePresetId) {
    return null;
  }
  const presetVoice = PREMADE_VOICES.find(
    (voice) => voice.id === voicePresetId,
  );
  if (!presetVoice) {
    return null;
  }

  const trimmedVoiceApiKey = voiceApiKey.trim();
  const mode =
    voiceProvider === "elevenlabs" && trimmedVoiceApiKey
      ? "own-key"
      : cloudTtsSelected
        ? "cloud"
        : undefined;

  return {
    provider: "elevenlabs",
    ...(mode ? { mode } : {}),
    elevenlabs: {
      voiceId: presetVoice.voiceId,
      ...(mode === "own-key" ? { apiKey: trimmedVoiceApiKey } : {}),
    },
  };
}

async function persistOnboardingStyleVoice(args: {
  style: StylePreset | undefined;
  voiceProvider: string;
  voiceApiKey: string;
  cloudTtsSelected: boolean;
  clientRef: ElizaClient;
}): Promise<void> {
  const voiceConfig = buildOnboardingStyleVoiceConfig(args);
  if (!voiceConfig) {
    return;
  }

  await args.clientRef.updateConfig({
    messages: {
      tts: voiceConfig,
    },
  });
}

export function buildOnboardingFeatureSubmitPayload(args: {
  onboardingFeatureTelegram: boolean;
  onboardingFeatureDiscord: boolean;
  onboardingFeatureBrowser: boolean;
  onboardingFeatureComputerUse: boolean;
}): {
  connectors?: Record<string, { enabled: true; managed: true }>;
  features?: Record<string, { enabled: true }>;
} {
  const connectors =
    args.onboardingFeatureTelegram || args.onboardingFeatureDiscord
      ? {
          ...(args.onboardingFeatureTelegram
            ? { telegram: { enabled: true as const, managed: true as const } }
            : {}),
          ...(args.onboardingFeatureDiscord
            ? { discord: { enabled: true as const, managed: true as const } }
            : {}),
        }
      : undefined;
  const featureEntries: Record<string, { enabled: true }> = {};
  if (args.onboardingFeatureBrowser)
    featureEntries.browser = { enabled: true as const };
  if (args.onboardingFeatureComputerUse)
    featureEntries.computeruse = { enabled: true as const };
  const features =
    Object.keys(featureEntries).length > 0 ? featureEntries : undefined;

  return {
    ...(connectors ? { connectors } : {}),
    ...(features ? { features } : {}),
  };
}

// ── Hook deps ─────────────────────────────────────────────────────────────

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
  client: ElizaClient;
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useOnboardingCallbacks(deps: OnboardingCallbacksDeps) {
  const {
    onboarding,
    setActiveOverlayApp,
    setOnboardingStep,
    setOnboardingMode: _setOnboardingMode,
    setOnboardingActiveGuide,
    setOnboardingDetectedProviders,
    setOnboardingServerTarget,
    setOnboardingCloudApiKey,
    setOnboardingProvider,
    setOnboardingApiKey,
    setOnboardingPrimaryModel: _setOnboardingPrimaryModel,
    setOnboardingRemoteApiBase,
    setOnboardingRemoteToken,
    setOnboardingRemoteConnecting,
    setOnboardingRemoteError,
    setOnboardingRemoteConnected,
    setPostOnboardingChecklistDismissed,
    setBrowserEnabled,
    setComputerUseEnabled,
    setOnboardingComplete,
    coordinatorOnboardingCompleteRef,
    initialTabSetRef,
    setTab,
    defaultLandingTab,
    loadCharacter,
    uiLanguage,
    selectedVrmIndex,
    walletConfig,
    elizaCloudConnected,
    setActionNotice,
    retryStartup,
    setWalletEnabled,
    forceLocalBootstrapRef,
    addDeferredOnboardingTask,
    client,
  } = deps;

  // Destructure state fields we need from the onboarding hook
  const {
    state: {
      step: onboardingStep,
      mode: onboardingMode,
      options: onboardingOptions,
      name: onboardingName,
      style: onboardingStyle,
      serverTarget: onboardingServerTarget,
      cloudApiKey: onboardingCloudApiKey,
      provider: onboardingProvider,
      apiKey: onboardingApiKey,
      voiceProvider: onboardingVoiceProvider,
      voiceApiKey: onboardingVoiceApiKey,
      smallModel: onboardingSmallModel,
      largeModel: onboardingLargeModel,
      openRouterModel: onboardingOpenRouterModel,
      primaryModel: onboardingPrimaryModel,
      detectedProviders: onboardingDetectedProviders,
      remoteApiBase: onboardingRemoteApiBase,
      remoteToken: onboardingRemoteToken,
      remote: onboardingRemote,
      rpcSelections: onboardingRpcSelections,
      rpcKeys: onboardingRpcKeys,
      featureTelegram: onboardingFeatureTelegram,
      featureDiscord: onboardingFeatureDiscord,
      featurePhone: onboardingFeaturePhone,
      featureCrypto: onboardingFeatureCrypto,
      featureBrowser: onboardingFeatureBrowser,
      featureComputerUse: onboardingFeatureComputerUse,
      cloudProvisionedContainer,
    },
    completionCommittedRef: onboardingCompletionCommittedRef,
  } = onboarding;

  const onboardingRemoteConnecting = onboardingRemote.status === "connecting";

  // ── completeOnboarding ────────────────────────────────────────────

  const completeOnboarding = useCallback(
    (
      landingTab: Tab = defaultLandingTab,
      options?: CompleteOnboardingOptions,
    ) => {
      clearPersistedOnboardingStep();
      onboardingCompletionCommittedRef.current = true;
      _setOnboardingMode("basic");
      setOnboardingActiveGuide(null);
      setPostOnboardingChecklistDismissed(false);
      setOnboardingDetectedProviders(
        onboardingDetectedProviders.map((provider) => {
          const { apiKey: _, ...rest } = provider;
          return rest;
        }) as AppState["onboardingDetectedProviders"],
      );
      setOnboardingComplete(true);
      coordinatorOnboardingCompleteRef.current?.();
      initialTabSetRef.current = true;
      const launchCompanionOverlay =
        options?.launchCompanionOverlay === true &&
        COMPANION_ENABLED &&
        APPS_ENABLED;
      if (launchCompanionOverlay) {
        setActiveOverlayApp("@elizaos/app-companion");
        replaceNavigationPathForCompanionLaunch();
        setTab("apps");
      } else {
        setTab(landingTab);
      }
      void loadCharacter();
    },
    [
      onboardingCompletionCommittedRef,
      onboardingDetectedProviders,
      setOnboardingActiveGuide,
      setOnboardingComplete,
      setOnboardingDetectedProviders,
      _setOnboardingMode,
      setPostOnboardingChecklistDismissed,
      setActiveOverlayApp,
      setTab,
      defaultLandingTab,
      loadCharacter,
      coordinatorOnboardingCompleteRef,
      initialTabSetRef,
    ],
  );

  // ── runOnboardingChatHandoff ──────────────────────────────────────

  const runOnboardingChatHandoff = useCallback(
    async (options?: OnboardingNextOptions) => {
      if (!onboardingOptions) return;

      try {
        const onboardingRunMode =
          onboardingMode === "elizacloudonly"
            ? "cloud"
            : onboardingMode === "basic" || onboardingMode === "advanced"
              ? "local"
              : "";
        const useCloudFastTrack = shouldUseCloudOnboardingFastTrack({
          cloudProvisionedContainer,
          elizaCloudConnected,
          onboardingRunMode,
          onboardingProvider,
        });
        const onboardingFeaturePayload = buildOnboardingFeatureSubmitPayload({
          onboardingFeatureTelegram,
          onboardingFeatureDiscord,
          onboardingFeatureBrowser,
          onboardingFeatureComputerUse,
        });
        const shouldApplyLocalCapabilities = onboardingStep === "features";
        const applySelectedLocalCapabilities = () => {
          if (!shouldApplyLocalCapabilities) return;
          setWalletEnabled?.(onboardingFeatureCrypto);
          setBrowserEnabled?.(onboardingFeatureBrowser);
          setComputerUseEnabled?.(onboardingFeatureComputerUse);
        };

        const runtimeConfig = buildOnboardingRuntimeConfig({
          onboardingServerTarget,
          onboardingCloudApiKey,
          onboardingProvider,
          onboardingApiKey,
          omitRuntimeProvider: options?.omitRuntimeProvider,
          onboardingVoiceProvider,
          onboardingVoiceApiKey,
          onboardingPrimaryModel,
          onboardingOpenRouterModel,
          onboardingRemoteConnected: onboardingRemote.status === "connected",
          onboardingRemoteApiBase,
          onboardingRemoteToken,
          onboardingSmallModel,
          onboardingLargeModel,
          onboardingFeatureTelegram,
          onboardingFeatureDiscord,
          onboardingFeaturePhone,
          onboardingFeatureCrypto,
          onboardingFeatureBrowser,
        });

        const rpcSel = onboardingRpcSelections as Record<string, string>;
        const rpcK = onboardingRpcKeys as Record<string, string>;
        const nextWalletConfig = buildWalletRpcUpdateRequest({
          walletConfig,
          rpcFieldValues: rpcK,
          selectedProviders: {
            evm: rpcSel.evm,
            bsc: rpcSel.bsc,
            solana: rpcSel.solana,
          },
        });

        if (useCloudFastTrack) {
          const style = resolveSelectedOnboardingStyle({
            styles: onboardingOptions.styles,
            onboardingStyle,
            selectedVrmIndex,
            uiLanguage,
          });
          const defaultName =
            style.name ?? getDefaultStylePreset(uiLanguage).name;
          const fastTrackSandboxMode = isElizaCloudOnboardingTarget(
            onboardingServerTarget,
          )
            ? "standard"
            : "off";

          await client.submitOnboarding({
            name: onboardingName || defaultName,
            sandboxMode: fastTrackSandboxMode as "off",
            bio: style?.bio ?? ["An autonomous AI agent."],
            systemPrompt:
              style?.system?.replace(
                /\{\{name\}\}/g,
                onboardingName || defaultName,
              ) ??
              `You are ${onboardingName || defaultName}, an autonomous AI agent powered by elizaOS.`,
            style: style?.style,
            adjectives: style?.adjectives,
            postExamples: style?.postExamples,
            messageExamples: style?.messageExamples,
            topics: style?.topics,
            avatarIndex: style?.avatarIndex ?? 1,
            language: uiLanguage,
            presetId: style?.id ?? getDefaultStylePreset(uiLanguage).id,
            deploymentTarget: runtimeConfig.deploymentTarget,
            ...(runtimeConfig.linkedAccounts
              ? { linkedAccounts: runtimeConfig.linkedAccounts }
              : {}),
            ...(runtimeConfig.serviceRouting
              ? { serviceRouting: runtimeConfig.serviceRouting }
              : {}),
            ...(runtimeConfig.credentialInputs
              ? { credentialInputs: runtimeConfig.credentialInputs }
              : {}),
            ...onboardingFeaturePayload,
            walletConfig: nextWalletConfig,
          } as Parameters<typeof client.submitOnboarding>[0]);
          try {
            await persistOnboardingStyleVoice({
              style,
              voiceProvider: onboardingVoiceProvider,
              voiceApiKey: onboardingVoiceApiKey,
              cloudTtsSelected:
                runtimeConfig.serviceRouting?.tts?.transport ===
                  "cloud-proxy" &&
                runtimeConfig.serviceRouting?.tts?.backend === "elizacloud",
              clientRef: client,
            });
          } catch (err) {
            console.warn(
              "[onboarding] Failed to persist cloud voice preset",
              err,
            );
          }

          applySelectedLocalCapabilities();
          if (runtimeConfig.needsProviderSetup) {
            setActionNotice(
              "Choose a chat provider in Settings to start chatting.",
              "info",
              6000,
            );
            completeOnboarding("settings");
            return;
          }
          await ensureOnboardedAgentRunning(client);

          completeOnboarding("chat", { launchCompanionOverlay: true });
          return;
        }

        const style = resolveSelectedOnboardingStyle({
          styles: onboardingOptions.styles,
          onboardingStyle,
          selectedVrmIndex,
          uiLanguage,
        });

        const systemPrompt = style?.system
          ? style.system.replace(/\{\{name\}\}/g, onboardingName)
          : `You are ${onboardingName}, an autonomous AI agent powered by elizaOS. ${onboardingOptions.sharedStyleRules}`;

        const isSandboxMode = isElizaCloudOnboardingTarget(
          onboardingServerTarget,
        );
        const isLocalMode =
          onboardingServerTarget === "local" || !onboardingServerTarget;
        const isRemoteMode = onboardingServerTarget === "remote";

        if (isSandboxMode) {
          const cloudApiBase =
            client.getBaseUrl().trim() ||
            getBootConfig().cloudApiBase ||
            "https://www.elizacloud.ai";
          const authToken = String(
            (globalThis as Record<string, unknown>)
              .__ELIZA_CLOUD_AUTH_TOKEN__ ?? "",
          );

          if (!authToken) {
            throw new Error(
              "Eliza Cloud authentication required. Please log in first.",
            );
          }

          const provisionedAgent = await client.provisionCloudSandbox({
            cloudApiBase,
            authToken,
            name: onboardingName,
            bio: style?.bio ?? ["An autonomous AI agent."],
            onProgress: (status, detail) => {
              console.log(`[Sandbox] ${status}: ${detail ?? ""}`);
            },
          });

          client.setBaseUrl(provisionedAgent.bridgeUrl);
          client.setToken(authToken);
          persistMobileRuntimeModeForServerTarget(onboardingServerTarget);
          savePersistedActiveServer(
            createPersistedActiveServer({
              kind: "cloud",
              apiBase: provisionedAgent.bridgeUrl,
              accessToken: authToken,
            }),
          );
        } else if (isLocalMode) {
          const desktopRuntimeMode = await getDesktopRuntimeMode().catch(
            () => null,
          );
          const shouldStartEmbeddedDesktopRuntime =
            !desktopRuntimeMode || desktopRuntimeMode.mode === "local";

          if (shouldStartEmbeddedDesktopRuntime) {
            try {
              await invokeDesktopBridgeRequest({
                rpcMethod: "agentStart",
                ipcChannel: "agent:start",
              });
            } catch {
              try {
                await startNativeAgentIfAvailable();
              } catch {
                /* dev mode where agent is already running */
              }
            }
          }

          const localDeadline = Date.now() + 120_000;
          let pollMs = 1000;
          while (Date.now() < localDeadline) {
            try {
              await client.getAuthStatus();
              break;
            } catch {
              await new Promise((r) => setTimeout(r, pollMs));
              pollMs = Math.min(pollMs * 1.5, 5000);
            }
          }

          savePersistedActiveServer(
            createPersistedActiveServer({ kind: "local" }),
          );
        } else if (isRemoteMode) {
          savePersistedActiveServer(
            createPersistedActiveServer({
              kind: "remote",
              apiBase: onboardingRemoteApiBase,
              accessToken: onboardingRemoteToken || undefined,
            }),
          );
        }

        const sandboxMode = isSandboxMode ? "standard" : "off";
        await client.submitOnboarding({
          name: onboardingName,
          sandboxMode: sandboxMode as "off",
          bio: style?.bio ?? ["An autonomous AI agent."],
          systemPrompt,
          style: style?.style,
          adjectives: style?.adjectives,
          topics: style?.topics,
          postExamples: style?.postExamples,
          messageExamples: style?.messageExamples,
          avatarIndex: style?.avatarIndex ?? selectedVrmIndex,
          language: uiLanguage,
          presetId:
            (style?.id ?? onboardingStyle) ||
            getDefaultStylePreset(uiLanguage).id,
          deploymentTarget: runtimeConfig.deploymentTarget,
          ...(runtimeConfig.linkedAccounts
            ? { linkedAccounts: runtimeConfig.linkedAccounts }
            : {}),
          ...(runtimeConfig.serviceRouting
            ? { serviceRouting: runtimeConfig.serviceRouting }
            : {}),
          ...(runtimeConfig.credentialInputs
            ? { credentialInputs: runtimeConfig.credentialInputs }
            : {}),
          ...onboardingFeaturePayload,
          walletConfig: nextWalletConfig,
        } as Parameters<typeof client.submitOnboarding>[0]);
        try {
          await persistOnboardingStyleVoice({
            style,
            voiceProvider: onboardingVoiceProvider,
            voiceApiKey: onboardingVoiceApiKey,
            cloudTtsSelected:
              runtimeConfig.serviceRouting?.tts?.transport === "cloud-proxy" &&
              runtimeConfig.serviceRouting?.tts?.backend === "elizacloud",
            clientRef: client,
          });
        } catch (err) {
          console.warn(
            "[onboarding] Failed to persist selected voice preset",
            err,
          );
        }

        applySelectedLocalCapabilities();
        if (runtimeConfig.needsProviderSetup) {
          setActionNotice(
            "Choose a chat provider in Settings to start chatting.",
            "info",
            6000,
          );
          completeOnboarding("settings");
          return;
        }
        await ensureOnboardedAgentRunning(client);

        completeOnboarding("chat", { launchCompanionOverlay: true });
      } catch (err) {
        console.error("[onboarding] Failed to complete onboarding", err);
        const message =
          err instanceof Error && err.message.trim()
            ? `Failed to complete onboarding: ${err.message}`
            : "Failed to complete onboarding.";
        setActionNotice(message, "error", 8000);
      }
    },
    [
      onboardingOptions,
      onboardingStyle,
      onboardingName,
      onboardingServerTarget,
      onboardingCloudApiKey,
      onboardingSmallModel,
      onboardingLargeModel,
      onboardingStep,
      onboardingProvider,
      onboardingApiKey,
      onboardingRemoteApiBase,
      onboardingRemote,
      onboardingRemoteToken,
      onboardingOpenRouterModel,
      onboardingPrimaryModel,
      onboardingFeatureTelegram,
      onboardingFeatureDiscord,
      onboardingFeaturePhone,
      onboardingFeatureCrypto,
      onboardingFeatureBrowser,
      onboardingFeatureComputerUse,
      onboardingVoiceProvider,
      onboardingVoiceApiKey,
      selectedVrmIndex,
      uiLanguage,
      onboardingRpcSelections,
      onboardingRpcKeys,
      setBrowserEnabled,
      setComputerUseEnabled,
      walletConfig,
      onboardingMode,
      elizaCloudConnected,
      cloudProvisionedContainer,
      completeOnboarding,
      client,
      setActionNotice,
      setWalletEnabled,
    ],
  );

  // ── handleOnboardingFinish ────────────────────────────────────────

  const handleOnboardingFinish = useCallback(
    async (options?: OnboardingNextOptions) => {
      await runOnboardingChatHandoff(options);
    },
    [runOnboardingChatHandoff],
  );

  // ── goToOnboardingStep ───────────────────────────────────────────

  const goToOnboardingStep = useCallback(
    (step: OnboardingStep) => {
      setOnboardingStep(step);
      setOnboardingActiveGuide(
        onboardingMode === "advanced"
          ? getFlaminaTopicForOnboardingStep(step)
          : null,
      );
    },
    [onboardingMode, setOnboardingStep, setOnboardingActiveGuide],
  );

  // ── applyResetConnectionWizardToHostingStep ───────────────────────
  // Clears any residual onboarding selection state. The old wizard used
  // this when jumping back to the "hosting" step so a stale remote/
  // provider screen wouldn't bleed through. RuntimeGate doesn't jump
  // between steps, but this still runs on revert paths.
  const applyResetConnectionWizardToHostingStep = useCallback(() => {
    const patch = {
      onboardingServerTarget: "" as const,
      onboardingCloudApiKey: "",
      onboardingApiKey: "",
      onboardingPrimaryModel: "",
      onboardingProvider: "",
      onboardingRemoteApiBase: "",
      onboardingRemoteToken: "",
      onboardingRemoteConnected: false,
      onboardingRemoteError: null,
      onboardingRemoteConnecting: false,
    };
    if (patch.onboardingServerTarget !== undefined) {
      persistMobileRuntimeModeForServerTarget(patch.onboardingServerTarget);
      setOnboardingServerTarget(patch.onboardingServerTarget);
    }
    if (patch.onboardingCloudApiKey !== undefined) {
      setOnboardingCloudApiKey(patch.onboardingCloudApiKey);
    }
    if (patch.onboardingProvider !== undefined) {
      setOnboardingProvider(patch.onboardingProvider);
    }
    if (patch.onboardingApiKey !== undefined) {
      setOnboardingApiKey(patch.onboardingApiKey);
    }
    if (patch.onboardingPrimaryModel !== undefined) {
      _setOnboardingPrimaryModel(patch.onboardingPrimaryModel);
    }
    if (patch.onboardingRemoteApiBase !== undefined) {
      setOnboardingRemoteApiBase(patch.onboardingRemoteApiBase);
    }
    if (patch.onboardingRemoteToken !== undefined) {
      setOnboardingRemoteToken(patch.onboardingRemoteToken);
    }
    if (patch.onboardingRemoteError !== undefined) {
      setOnboardingRemoteError(patch.onboardingRemoteError);
    }
    if (patch.onboardingRemoteConnecting !== undefined) {
      setOnboardingRemoteConnecting(patch.onboardingRemoteConnecting);
    }
    if (patch.onboardingRemoteConnected !== undefined) {
      setOnboardingRemoteConnected(patch.onboardingRemoteConnected);
    }
  }, [
    setOnboardingApiKey,
    setOnboardingCloudApiKey,
    setOnboardingServerTarget,
    _setOnboardingPrimaryModel,
    setOnboardingProvider,
    setOnboardingRemoteApiBase,
    setOnboardingRemoteConnecting,
    setOnboardingRemoteConnected,
    setOnboardingRemoteError,
    setOnboardingRemoteToken,
  ]);

  // ── advanceOnboarding / handleOnboardingNext ─────────────────────

  const advanceOnboarding = useCallback(
    async (options?: OnboardingNextOptions) => {
      if (
        shouldSkipConnectionStepsForCloudProvisionedContainer({
          currentStep: onboardingStep,
          cloudProvisionedContainer,
        })
      ) {
        await handleOnboardingFinish(options);
        return;
      }

      if (onboardingStep === "providers" && options?.allowPermissionBypass) {
        if (options.skipTask) addDeferredOnboardingTask(options.skipTask);
      }

      const nextStep = resolveOnboardingNextStep(onboardingStep);

      // Keep any target-specific feature-step shortcuts centralized in flow.ts.
      if (
        nextStep === "features" &&
        shouldSkipFeaturesStep({ onboardingServerTarget })
      ) {
        await handleOnboardingFinish(options);
        return;
      }

      if (!nextStep) {
        // Last step (features) — finish onboarding and go to chat
        await handleOnboardingFinish(options);
        return;
      }

      if (nextStep) {
        setOnboardingStep(nextStep);
        setOnboardingActiveGuide(
          onboardingMode === "advanced"
            ? getFlaminaTopicForOnboardingStep(nextStep)
            : null,
        );
      }
    },
    [
      handleOnboardingFinish,
      onboardingMode,
      onboardingStep,
      onboardingServerTarget,
      setOnboardingStep,
      setOnboardingActiveGuide,
      cloudProvisionedContainer,
      addDeferredOnboardingTask,
    ],
  );

  const handleOnboardingNext = useCallback(
    async (options?: OnboardingNextOptions) => advanceOnboarding(options),
    [advanceOnboarding],
  );

  // ── revertOnboarding / handleOnboardingBack ──────────────────────

  const revertOnboarding = useCallback(() => {
    const previousStep = resolveOnboardingPreviousStep(onboardingStep);

    if (!previousStep) return;
    // Reset connection subflow when leaving "providers" so the user starts
    // fresh at the hosting screen when they advance again.
    if (onboardingStep === "providers") {
      applyResetConnectionWizardToHostingStep();
    }
    setOnboardingStep(previousStep);
    setOnboardingActiveGuide(
      onboardingMode === "advanced"
        ? getFlaminaTopicForOnboardingStep(previousStep)
        : null,
    );
  }, [
    applyResetConnectionWizardToHostingStep,
    onboardingMode,
    onboardingStep,
    setOnboardingActiveGuide,
    setOnboardingStep,
  ]);

  const handleOnboardingBack = revertOnboarding;

  // ── handleOnboardingJumpToStep ───────────────────────────────────

  const handleOnboardingJumpToStep = useCallback(
    (target: OnboardingStep) => {
      if (!canRevertOnboardingTo({ current: onboardingStep, target })) return;
      const currentStepIndex = getOnboardingStepIndex(onboardingStep);
      const targetStepIndex = getOnboardingStepIndex(target);
      const providersStepIndex = getOnboardingStepIndex("providers");

      // Sidebar back jumps must match repeated Back semantics, including the
      // connection wizard reset when the jump crosses back past providers.
      if (
        currentStepIndex >= providersStepIndex &&
        targetStepIndex < providersStepIndex
      ) {
        applyResetConnectionWizardToHostingStep();
      }
      if (target === "deployment") {
        persistMobileRuntimeModeForServerTarget("");
        setOnboardingServerTarget("");
      }
      setOnboardingStep(target);
      setOnboardingActiveGuide(
        onboardingMode === "advanced"
          ? getFlaminaTopicForOnboardingStep(target)
          : null,
      );
    },
    [
      applyResetConnectionWizardToHostingStep,
      onboardingMode,
      onboardingStep,
      setOnboardingStep,
      setOnboardingActiveGuide,
      setOnboardingServerTarget,
    ],
  );

  // ── handleOnboardingUseLocalBackend ──────────────────────────────

  const handleOnboardingUseLocalBackend = useCallback(() => {
    forceLocalBootstrapRef.current = true;
    clearPersistedActiveServer();
    client.setBaseUrl(null);
    client.setToken(null);
    setOnboardingRemoteConnecting(false);
    setOnboardingRemoteError(null);
    setOnboardingRemoteConnected(false);
    setOnboardingRemoteApiBase("");
    setOnboardingRemoteToken("");
    persistMobileRuntimeModeForServerTarget("");
    setOnboardingServerTarget("");
    setActionNotice(
      "Checking this device for an existing Eliza setup...",
      "info",
      3200,
    );
    retryStartup();
  }, [
    retryStartup,
    setActionNotice,
    forceLocalBootstrapRef,
    setOnboardingRemoteApiBase,
    setOnboardingRemoteConnected,
    setOnboardingRemoteConnecting,
    setOnboardingRemoteError,
    setOnboardingRemoteToken,
    setOnboardingServerTarget,
    client,
  ]);

  // ── handleOnboardingRemoteConnect ────────────────────────────────

  const handleOnboardingRemoteConnect = useCallback(async () => {
    if (onboardingRemoteConnecting) return;
    let normalizedBase = "";
    try {
      normalizedBase = normalizeRemoteApiBaseInput(onboardingRemoteApiBase);
    } catch (err) {
      setOnboardingRemoteError(
        err instanceof Error ? err.message : "Enter a valid backend address.",
      );
      return;
    }

    const accessKey = onboardingRemoteToken.trim();
    const probe = new ElizaClient(normalizedBase, accessKey || undefined);
    setOnboardingRemoteConnecting(true);
    setOnboardingRemoteError(null);
    try {
      const auth = await probe.getAuthStatus();
      if (auth.required && !accessKey) {
        throw new Error("This backend requires an access key.");
      }
      await probe.getOnboardingStatus();
      savePersistedActiveServer(
        createPersistedActiveServer({
          kind: "remote",
          apiBase: normalizedBase,
          ...(accessKey ? { accessToken: accessKey } : {}),
        }),
      );
      persistMobileRuntimeModeForServerTarget("remote");
      setOnboardingServerTarget("remote");
      setOnboardingRemoteApiBase(normalizedBase);
      setOnboardingRemoteToken(accessKey);
      setOnboardingRemoteConnected(true);
      setActionNotice("Connected to remote backend.", "success", 4200);
      retryStartup();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to reach remote backend.";
      const normalizedMessage =
        /401|unauthorized|forbidden/i.test(message) && accessKey
          ? "Access key rejected. Check the address and try again."
          : message;
      setOnboardingRemoteError(normalizedMessage);
    } finally {
      setOnboardingRemoteConnecting(false);
    }
  }, [
    onboardingRemoteApiBase,
    onboardingRemoteConnecting,
    onboardingRemoteToken,
    retryStartup,
    setActionNotice,
    setOnboardingRemoteApiBase,
    setOnboardingRemoteConnected,
    setOnboardingRemoteConnecting,
    setOnboardingRemoteError,
    setOnboardingRemoteToken,
    setOnboardingServerTarget,
  ]);

  // ── handleCloudOnboardingFinish ──────────────────────────────────

  const handleCloudOnboardingFinish = useCallback(async () => {
    await runOnboardingChatHandoff();
  }, [runOnboardingChatHandoff]);

  // ── applyDetectedProviders ───────────────────────────────────────

  const applyDetectedProviders = useCallback(
    (detected: Awaited<ReturnType<typeof scanProviderCredentials>>) => {
      setOnboardingDetectedProviders(
        detected as typeof detected & AppState["onboardingDetectedProviders"],
      );
    },
    [setOnboardingDetectedProviders],
  );

  return {
    completeOnboarding,
    runOnboardingChatHandoff,
    handleOnboardingFinish,
    goToOnboardingStep,
    applyResetConnectionWizardToHostingStep,
    advanceOnboarding,
    handleOnboardingNext,
    revertOnboarding,
    handleOnboardingBack,
    handleOnboardingJumpToStep,
    handleOnboardingUseLocalBackend,
    handleOnboardingRemoteConnect,
    handleCloudOnboardingFinish,
    applyDetectedProviders,
  };
}
