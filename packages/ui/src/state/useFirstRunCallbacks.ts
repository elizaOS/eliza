/**
 * First-run callbacks — extracted from AppContext.
 *
 * Holds all the callback functions for the first-run setup:
 * completeFirstRun, runFirstRunChatHandoff, handleFirstRunFinish,
 * advanceFirstRun / handleFirstRunNext, revertFirstRun /
 * handleFirstRunBack, handleFirstRunJumpToStep, goToFirstRunStep,
 * applyResetConnectionWizardToHostingStep, handleCloudFirstRunFinish,
 * handleFirstRunUseLocalBackend, handleFirstRunRemoteConnect,
 * and applyDetectedProviders.
 */

import { Capacitor } from "@capacitor/core";
import {
  buildWalletRpcUpdateRequest,
  getDefaultStylePreset,
} from "@elizaos/shared";
import { type RefObject, useCallback } from "react";
import type { StylePreset, VoiceConfig } from "../api";
import { ElizaClient } from "../api/client-base";
import { resolveCloudAgentApiBase } from "../api/client-cloud";

type FirstRunClient = Pick<
  ElizaClient,
  | "getAuthStatus"
  | "getBaseUrl"
  | "getStatus"
  | "provisionCloudSandbox"
  | "setBaseUrl"
  | "setToken"
  | "startAgent"
  | "submitFirstRun"
  | "updateConfig"
>;

const ensureFirstRunAgentRunning = async (
  client: FirstRunClient,
): Promise<void> => {
  try {
    const status = await client.getStatus();
    if (status?.state !== "running" && status?.state !== "starting") {
      await client.startAgent();
    }
  } catch {
    // Non-fatal: agent manager may not be ready yet. First-run will retry.
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

import {
  getDesktopRuntimeMode,
  invokeDesktopBridgeRequest,
  type scanProviderCredentials,
} from "../bridge";
import { getBootConfig } from "../config/boot-config";
import { ensureStoreBuildWorkspaceFolder } from "../first-run/ensure-store-build-workspace-folder";
import { buildFirstRunRuntimeConfig } from "../first-run/first-run-config";
import { persistMobileRuntimeModeForServerTarget } from "../first-run/mobile-runtime-mode";
import { isElizaCloudFirstRunTarget } from "../first-run/runtime-target";
import {
  canRevertSetupTo,
  getFlaminaTopicForSetupStep,
  getSetupStepIndex,
  resolveSetupNextStep,
  resolveSetupPreviousStep,
  shouldSkipConnectionStepsForCloudProvisionedContainer,
  shouldUseCloudSetupFastTrack,
} from "../first-run/setup-steps";
import type { UiLanguage } from "../i18n";
import { APPS_ENABLED, COMPANION_ENABLED, type Tab } from "../navigation";
import { PREMADE_VOICES } from "../voice/types";
import {
  clearPersistedActiveServer,
  clearPersistedSetupStep,
  createPersistedActiveServer,
  type FirstRunNextOptions,
  savePersistedActiveServer,
} from "./internal";
import type { AppState, CompleteFirstRunOptions, SetupStep } from "./types";
import type { FirstRunStateHook } from "./useFirstRunState";

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

function resolveSelectedFirstRunStyle(args: {
  styles: readonly StylePreset[] | undefined;
  firstRunStyle: string;
  selectedVrmIndex: number;
  uiLanguage: UiLanguage;
}): StylePreset {
  const styles = args.styles ?? [];
  return (
    styles.find((style) => style.id === args.firstRunStyle) ??
    styles.find(
      (style) =>
        typeof style.avatarIndex === "number" &&
        style.avatarIndex === args.selectedVrmIndex,
    ) ??
    styles[0] ??
    getDefaultStylePreset(args.uiLanguage)
  );
}

export function buildFirstRunStyleVoiceConfig(args: {
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

async function persistFirstRunStyleVoice(args: {
  style: StylePreset | undefined;
  voiceProvider: string;
  voiceApiKey: string;
  cloudTtsSelected: boolean;
  clientRef: Pick<FirstRunClient, "updateConfig">;
}): Promise<void> {
  const voiceConfig = buildFirstRunStyleVoiceConfig(args);
  if (!voiceConfig) {
    return;
  }

  await args.clientRef.updateConfig({
    messages: {
      tts: voiceConfig,
    },
  });
}

export function buildFirstRunCapabilitySubmitPayload(args: {
  firstRunFeatureTelegram: boolean;
  firstRunFeatureDiscord: boolean;
  firstRunFeatureBrowser: boolean;
  firstRunFeatureComputerUse: boolean;
}): {
  connectors?: Record<string, { enabled: true; managed: true }>;
  features?: Record<string, { enabled: true }>;
} {
  const connectors =
    args.firstRunFeatureTelegram || args.firstRunFeatureDiscord
      ? {
          ...(args.firstRunFeatureTelegram
            ? { telegram: { enabled: true as const, managed: true as const } }
            : {}),
          ...(args.firstRunFeatureDiscord
            ? { discord: { enabled: true as const, managed: true as const } }
            : {}),
        }
      : undefined;
  const featureEntries: Record<string, { enabled: true }> = {};
  if (args.firstRunFeatureBrowser)
    featureEntries.browser = { enabled: true as const };
  if (args.firstRunFeatureComputerUse)
    featureEntries.computeruse = { enabled: true as const };
  const features =
    Object.keys(featureEntries).length > 0 ? featureEntries : undefined;

  return {
    ...(connectors ? { connectors } : {}),
    ...(features ? { features } : {}),
  };
}

// ── Hook deps ─────────────────────────────────────────────────────────────

export interface FirstRunCallbacksDeps {
  /** Full result of useFirstRunState — state + all dispatch helpers. */
  firstRun: FirstRunStateHook;

  setActiveOverlayApp: (appName: string | null) => void;

  /**
   * Compat setter functions that already wrap firstRun.setField / dispatch.
   * Passed in from AppContext so we don't duplicate them here.
   */
  setSetupStep: (step: SetupStep) => void;
  setFirstRunMode: (v: AppState["firstRunMode"]) => void;
  setFirstRunActiveGuide: (v: string | null) => void;
  addDeferredFirstRunTask: (task: string) => void;
  setFirstRunDetectedProviders: (
    v: AppState["firstRunDetectedProviders"],
  ) => void;
  setFirstRunRuntimeTarget: (v: AppState["firstRunRuntimeTarget"]) => void;
  setFirstRunCloudApiKey: (v: string) => void;
  setFirstRunProvider: (v: string) => void;
  setFirstRunApiKey: (v: string) => void;
  setFirstRunPrimaryModel: (v: string) => void;
  setFirstRunRemoteApiBase: (v: string) => void;
  setFirstRunRemoteToken: (v: string) => void;
  setFirstRunRemoteConnecting: (v: boolean) => void;
  setFirstRunRemoteError: (v: string | null) => void;
  setFirstRunRemoteConnected: (v: boolean) => void;
  setPostFirstRunChecklistDismissed: (v: boolean) => void;
  setBrowserEnabled?: (v: boolean) => void;
  setComputerUseEnabled?: (v: boolean) => void;
  setWalletEnabled?: (v: boolean) => void;

  /** Lifecycle / global */
  setFirstRunComplete: (v: boolean) => void;
  coordinatorFirstRunCompleteRef: RefObject<(() => void) | null>;
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
  client: FirstRunClient;
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useFirstRunCallbacks(deps: FirstRunCallbacksDeps) {
  const {
    firstRun,
    setActiveOverlayApp,
    setSetupStep,
    setFirstRunMode: _setFirstRunMode,
    setFirstRunActiveGuide,
    setFirstRunDetectedProviders,
    setFirstRunRuntimeTarget,
    setFirstRunCloudApiKey,
    setFirstRunProvider,
    setFirstRunApiKey,
    setFirstRunPrimaryModel: _setFirstRunPrimaryModel,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteToken,
    setFirstRunRemoteConnecting,
    setFirstRunRemoteError,
    setFirstRunRemoteConnected,
    setPostFirstRunChecklistDismissed,
    setBrowserEnabled,
    setComputerUseEnabled,
    setFirstRunComplete,
    coordinatorFirstRunCompleteRef,
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
    addDeferredFirstRunTask,
    client,
  } = deps;

  // Destructure state fields we need from the firstRun hook
  const {
    state: {
      step: setupStep,
      mode: firstRunMode,
      options: firstRunOptions,
      name: firstRunName,
      style: firstRunStyle,
      serverTarget: firstRunRuntimeTarget,
      cloudApiKey: firstRunCloudApiKey,
      provider: firstRunProvider,
      apiKey: firstRunApiKey,
      voiceProvider: firstRunVoiceProvider,
      voiceApiKey: firstRunVoiceApiKey,
      smallModel: firstRunSmallModel,
      largeModel: firstRunLargeModel,
      openRouterModel: firstRunOpenRouterModel,
      primaryModel: firstRunPrimaryModel,
      detectedProviders: firstRunDetectedProviders,
      remoteApiBase: firstRunRemoteApiBase,
      remoteToken: firstRunRemoteToken,
      remote: firstRunRemote,
      rpcSelections: firstRunRpcSelections,
      rpcKeys: firstRunRpcKeys,
      featureTelegram: firstRunFeatureTelegram,
      featureDiscord: firstRunFeatureDiscord,
      featurePhone: firstRunFeaturePhone,
      featureCrypto: firstRunFeatureCrypto,
      featureBrowser: firstRunFeatureBrowser,
      featureComputerUse: firstRunFeatureComputerUse,
      cloudProvisionedContainer,
    },
    completionCommittedRef: firstRunCompletionCommittedRef,
  } = firstRun;

  const firstRunRemoteConnecting = firstRunRemote.status === "connecting";

  // ── completeFirstRun ────────────────────────────────────────────

  const completeFirstRun = useCallback(
    (
      landingTab: Tab = defaultLandingTab,
      options?: CompleteFirstRunOptions,
    ) => {
      clearPersistedSetupStep();
      firstRunCompletionCommittedRef.current = true;
      _setFirstRunMode("basic");
      setFirstRunActiveGuide(null);
      setPostFirstRunChecklistDismissed(false);
      setFirstRunDetectedProviders(
        firstRunDetectedProviders.map((provider) => {
          const { apiKey: _, ...rest } = provider;
          return rest;
        }) as AppState["firstRunDetectedProviders"],
      );
      setFirstRunComplete(true);
      coordinatorFirstRunCompleteRef.current?.();
      initialTabSetRef.current = true;
      const launchCompanionOverlay =
        options?.launchCompanionOverlay === true &&
        COMPANION_ENABLED &&
        APPS_ENABLED;
      if (launchCompanionOverlay && landingTab !== "home") {
        setActiveOverlayApp("@elizaos/plugin-companion");
        replaceNavigationPathForCompanionLaunch();
        setTab("apps");
      } else {
        setTab(landingTab);
      }
      void loadCharacter();
    },
    [
      firstRunCompletionCommittedRef,
      firstRunDetectedProviders,
      setFirstRunActiveGuide,
      setFirstRunComplete,
      setFirstRunDetectedProviders,
      _setFirstRunMode,
      setPostFirstRunChecklistDismissed,
      setActiveOverlayApp,
      setTab,
      defaultLandingTab,
      loadCharacter,
      coordinatorFirstRunCompleteRef,
      initialTabSetRef,
    ],
  );

  // ── runFirstRunChatHandoff ──────────────────────────────────────

  const runFirstRunChatHandoff = useCallback(
    async (options?: FirstRunNextOptions) => {
      if (!firstRunOptions) return;

      try {
        const firstRunRunMode =
          firstRunMode === "elizacloudonly"
            ? "cloud"
            : firstRunMode === "basic" || firstRunMode === "advanced"
              ? "local"
              : "";
        const useCloudFastTrack = shouldUseCloudSetupFastTrack({
          cloudProvisionedContainer,
          elizaCloudConnected,
          firstRunRunMode,
          firstRunProvider,
        });
        const firstRunCapabilityPayload = buildFirstRunCapabilitySubmitPayload({
          firstRunFeatureTelegram,
          firstRunFeatureDiscord,
          firstRunFeatureBrowser,
          firstRunFeatureComputerUse,
        });
        const shouldApplyLocalCapabilities = setupStep === "capabilities";
        const applySelectedLocalCapabilities = () => {
          if (!shouldApplyLocalCapabilities) return;
          setWalletEnabled?.(firstRunFeatureCrypto);
          setBrowserEnabled?.(firstRunFeatureBrowser);
          setComputerUseEnabled?.(firstRunFeatureComputerUse);
        };

        const runtimeConfig = buildFirstRunRuntimeConfig({
          firstRunRuntimeTarget,
          firstRunCloudApiKey,
          firstRunProvider,
          firstRunApiKey,
          omitRuntimeProvider: options?.omitRuntimeProvider,
          firstRunVoiceProvider,
          firstRunVoiceApiKey,
          firstRunPrimaryModel,
          firstRunOpenRouterModel,
          firstRunRemoteConnected: firstRunRemote.status === "connected",
          firstRunRemoteApiBase,
          firstRunRemoteToken,
          firstRunSmallModel,
          firstRunLargeModel,
          firstRunFeatureTelegram,
          firstRunFeatureDiscord,
          firstRunFeaturePhone,
          firstRunFeatureCrypto,
          firstRunFeatureBrowser,
        });

        const rpcSel = firstRunRpcSelections as Record<string, string>;
        const rpcK = firstRunRpcKeys as Record<string, string>;
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
          const style = resolveSelectedFirstRunStyle({
            styles: firstRunOptions.styles,
            firstRunStyle,
            selectedVrmIndex,
            uiLanguage,
          });
          const defaultName =
            style.name ?? getDefaultStylePreset(uiLanguage).name;
          const fastTrackSandboxMode = isElizaCloudFirstRunTarget(
            firstRunRuntimeTarget,
          )
            ? "standard"
            : "off";

          await client.submitFirstRun({
            name: firstRunName || defaultName,
            sandboxMode: fastTrackSandboxMode as "off",
            bio: style?.bio ?? ["An autonomous AI agent."],
            systemPrompt:
              style?.system?.replace(
                /\{\{name\}\}/g,
                firstRunName || defaultName,
              ) ??
              `You are ${firstRunName || defaultName}, an autonomous AI agent powered by elizaOS.`,
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
            ...firstRunCapabilityPayload,
            walletConfig: nextWalletConfig,
          } as Parameters<FirstRunClient["submitFirstRun"]>[0]);
          try {
            await persistFirstRunStyleVoice({
              style,
              voiceProvider: firstRunVoiceProvider,
              voiceApiKey: firstRunVoiceApiKey,
              cloudTtsSelected:
                runtimeConfig.serviceRouting?.tts?.transport ===
                  "cloud-proxy" &&
                runtimeConfig.serviceRouting?.tts?.backend === "elizacloud",
              clientRef: client,
            });
          } catch {
            // voice preset persistence is best-effort
          }

          applySelectedLocalCapabilities();
          if (runtimeConfig.needsProviderSetup) {
            setActionNotice(
              "Choose a chat provider in Settings to start chatting.",
              "info",
              6000,
            );
            completeFirstRun("settings");
            return;
          }
          await ensureFirstRunAgentRunning(client);

          completeFirstRun("home", { launchCompanionOverlay: true });
          return;
        }

        const style = resolveSelectedFirstRunStyle({
          styles: firstRunOptions.styles,
          firstRunStyle,
          selectedVrmIndex,
          uiLanguage,
        });

        const systemPrompt = style?.system
          ? style.system.replace(/\{\{name\}\}/g, firstRunName)
          : `You are ${firstRunName}, an autonomous AI agent powered by elizaOS. ${firstRunOptions.sharedStyleRules}`;

        const isSandboxMode = isElizaCloudFirstRunTarget(firstRunRuntimeTarget);
        const isLocalMode =
          firstRunRuntimeTarget === "local" || !firstRunRuntimeTarget;
        const isRemoteMode = firstRunRuntimeTarget === "remote";

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
            name: firstRunName,
            bio: style?.bio ?? ["An autonomous AI agent."],
            onProgress: () => {},
          });

          // The provision endpoint hands back `bridgeUrl` as a raw container
          // address (http://<ip>:<port>) that the browser can't reach (bridge
          // port firewalled to the cloud's internal network) and that the CSP
          // blocks (only https:// is allowed for remote hosts). Resolve the
          // reachable per-agent HTTPS gateway URL instead, so onboarding can
          // actually talk to the provisioned agent.
          const cloudAgentApiBase = resolveCloudAgentApiBase({
            agentId: provisionedAgent.agentId,
            cloudApiBase,
            bridgeUrl: provisionedAgent.bridgeUrl,
            webUiUrl: provisionedAgent.webUiUrl,
          });
          client.setBaseUrl(cloudAgentApiBase);
          client.setToken(authToken);
          persistMobileRuntimeModeForServerTarget(firstRunRuntimeTarget);
          savePersistedActiveServer(
            createPersistedActiveServer({
              kind: "cloud",
              apiBase: cloudAgentApiBase,
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
              apiBase: firstRunRemoteApiBase,
              accessToken: firstRunRemoteToken || undefined,
            }),
          );
        }

        const sandboxMode = isSandboxMode ? "standard" : "off";
        await client.submitFirstRun({
          name: firstRunName,
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
            (style?.id ?? firstRunStyle) ||
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
          ...firstRunCapabilityPayload,
          walletConfig: nextWalletConfig,
        } as Parameters<FirstRunClient["submitFirstRun"]>[0]);
        try {
          await persistFirstRunStyleVoice({
            style,
            voiceProvider: firstRunVoiceProvider,
            voiceApiKey: firstRunVoiceApiKey,
            cloudTtsSelected:
              runtimeConfig.serviceRouting?.tts?.transport === "cloud-proxy" &&
              runtimeConfig.serviceRouting?.tts?.backend === "elizacloud",
            clientRef: client,
          });
        } catch {
          // voice preset persistence is best-effort
        }

        applySelectedLocalCapabilities();
        if (runtimeConfig.needsProviderSetup) {
          setActionNotice(
            "Choose a chat provider in Settings to start chatting.",
            "info",
            6000,
          );
          completeFirstRun("settings");
          return;
        }
        await ensureFirstRunAgentRunning(client);

        completeFirstRun("home", { launchCompanionOverlay: true });
      } catch (err) {
        const message =
          err instanceof Error && err.message.trim()
            ? `Failed to complete firstRun: ${err.message}`
            : "Failed to complete firstRun.";
        setActionNotice(message, "error", 8000);
      }
    },
    [
      firstRunOptions,
      firstRunStyle,
      firstRunName,
      firstRunRuntimeTarget,
      firstRunCloudApiKey,
      firstRunSmallModel,
      firstRunLargeModel,
      setupStep,
      firstRunProvider,
      firstRunApiKey,
      firstRunRemoteApiBase,
      firstRunRemote,
      firstRunRemoteToken,
      firstRunOpenRouterModel,
      firstRunPrimaryModel,
      firstRunFeatureTelegram,
      firstRunFeatureDiscord,
      firstRunFeaturePhone,
      firstRunFeatureCrypto,
      firstRunFeatureBrowser,
      firstRunFeatureComputerUse,
      firstRunVoiceProvider,
      firstRunVoiceApiKey,
      selectedVrmIndex,
      uiLanguage,
      firstRunRpcSelections,
      firstRunRpcKeys,
      setBrowserEnabled,
      setComputerUseEnabled,
      walletConfig,
      firstRunMode,
      elizaCloudConnected,
      cloudProvisionedContainer,
      completeFirstRun,
      client,
      setActionNotice,
      setWalletEnabled,
    ],
  );

  // ── handleFirstRunFinish ────────────────────────────────────────

  const handleFirstRunFinish = useCallback(
    async (options?: FirstRunNextOptions) => {
      await runFirstRunChatHandoff(options);
    },
    [runFirstRunChatHandoff],
  );

  // ── goToFirstRunStep ───────────────────────────────────────────

  const goToFirstRunStep = useCallback(
    (step: SetupStep) => {
      setSetupStep(step);
      setFirstRunActiveGuide(
        firstRunMode === "advanced" ? getFlaminaTopicForSetupStep(step) : null,
      );
    },
    [firstRunMode, setSetupStep, setFirstRunActiveGuide],
  );

  // ── applyResetConnectionWizardToHostingStep ───────────────────────
  // Clears residual runtime and provider selection state before a user
  // picks a different setup target.
  const applyResetConnectionWizardToHostingStep = useCallback(() => {
    const patch = {
      firstRunRuntimeTarget: "" as const,
      firstRunCloudApiKey: "",
      firstRunApiKey: "",
      firstRunPrimaryModel: "",
      firstRunProvider: "",
      firstRunRemoteApiBase: "",
      firstRunRemoteToken: "",
      firstRunRemoteConnected: false,
      firstRunRemoteError: null,
      firstRunRemoteConnecting: false,
    };
    if (patch.firstRunRuntimeTarget !== undefined) {
      persistMobileRuntimeModeForServerTarget(patch.firstRunRuntimeTarget);
      setFirstRunRuntimeTarget(patch.firstRunRuntimeTarget);
    }
    if (patch.firstRunCloudApiKey !== undefined) {
      setFirstRunCloudApiKey(patch.firstRunCloudApiKey);
    }
    if (patch.firstRunProvider !== undefined) {
      setFirstRunProvider(patch.firstRunProvider);
    }
    if (patch.firstRunApiKey !== undefined) {
      setFirstRunApiKey(patch.firstRunApiKey);
    }
    if (patch.firstRunPrimaryModel !== undefined) {
      _setFirstRunPrimaryModel(patch.firstRunPrimaryModel);
    }
    if (patch.firstRunRemoteApiBase !== undefined) {
      setFirstRunRemoteApiBase(patch.firstRunRemoteApiBase);
    }
    if (patch.firstRunRemoteToken !== undefined) {
      setFirstRunRemoteToken(patch.firstRunRemoteToken);
    }
    if (patch.firstRunRemoteError !== undefined) {
      setFirstRunRemoteError(patch.firstRunRemoteError);
    }
    if (patch.firstRunRemoteConnecting !== undefined) {
      setFirstRunRemoteConnecting(patch.firstRunRemoteConnecting);
    }
    if (patch.firstRunRemoteConnected !== undefined) {
      setFirstRunRemoteConnected(patch.firstRunRemoteConnected);
    }
  }, [
    setFirstRunApiKey,
    setFirstRunCloudApiKey,
    setFirstRunRuntimeTarget,
    _setFirstRunPrimaryModel,
    setFirstRunProvider,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteConnecting,
    setFirstRunRemoteConnected,
    setFirstRunRemoteError,
    setFirstRunRemoteToken,
  ]);

  // ── advanceFirstRun / handleFirstRunNext ─────────────────────

  const advanceFirstRun = useCallback(
    async (options?: FirstRunNextOptions) => {
      if (
        shouldSkipConnectionStepsForCloudProvisionedContainer({
          currentStep: setupStep,
          cloudProvisionedContainer,
        })
      ) {
        await handleFirstRunFinish(options);
        return;
      }

      if (setupStep === "model" && options?.allowPermissionBypass) {
        if (options.skipTask) addDeferredFirstRunTask(options.skipTask);
      }

      if (setupStep === "connection") {
        await ensureStoreBuildWorkspaceFolder();
      }

      const nextStep = resolveSetupNextStep(setupStep);

      if (!nextStep) {
        await handleFirstRunFinish(options);
        return;
      }

      if (nextStep) {
        setSetupStep(nextStep);
        setFirstRunActiveGuide(
          firstRunMode === "advanced"
            ? getFlaminaTopicForSetupStep(nextStep)
            : null,
        );
      }
    },
    [
      handleFirstRunFinish,
      firstRunMode,
      setupStep,
      setSetupStep,
      setFirstRunActiveGuide,
      cloudProvisionedContainer,
      addDeferredFirstRunTask,
    ],
  );

  const handleFirstRunNext = useCallback(
    async (options?: FirstRunNextOptions) => advanceFirstRun(options),
    [advanceFirstRun],
  );

  // ── revertFirstRun / handleFirstRunBack ──────────────────────

  const revertFirstRun = useCallback(() => {
    const previousStep = resolveSetupPreviousStep(setupStep);

    if (!previousStep) return;
    if (setupStep === "model") {
      applyResetConnectionWizardToHostingStep();
    }
    setSetupStep(previousStep);
    setFirstRunActiveGuide(
      firstRunMode === "advanced"
        ? getFlaminaTopicForSetupStep(previousStep)
        : null,
    );
  }, [
    applyResetConnectionWizardToHostingStep,
    firstRunMode,
    setupStep,
    setFirstRunActiveGuide,
    setSetupStep,
  ]);

  const handleFirstRunBack = revertFirstRun;

  // ── handleFirstRunJumpToStep ───────────────────────────────────

  const handleFirstRunJumpToStep = useCallback(
    (target: SetupStep) => {
      if (!canRevertSetupTo({ current: setupStep, target })) return;
      const currentStepIndex = getSetupStepIndex(setupStep);
      const targetStepIndex = getSetupStepIndex(target);
      const modelStepIndex = getSetupStepIndex("model");

      if (
        currentStepIndex >= modelStepIndex &&
        targetStepIndex < modelStepIndex
      ) {
        applyResetConnectionWizardToHostingStep();
      }
      if (target === "connection") {
        persistMobileRuntimeModeForServerTarget("");
        setFirstRunRuntimeTarget("");
      }
      setSetupStep(target);
      setFirstRunActiveGuide(
        firstRunMode === "advanced"
          ? getFlaminaTopicForSetupStep(target)
          : null,
      );
    },
    [
      applyResetConnectionWizardToHostingStep,
      firstRunMode,
      setupStep,
      setSetupStep,
      setFirstRunActiveGuide,
      setFirstRunRuntimeTarget,
    ],
  );

  // ── handleFirstRunUseLocalBackend ──────────────────────────────

  const handleFirstRunUseLocalBackend = useCallback(() => {
    forceLocalBootstrapRef.current = true;
    clearPersistedActiveServer();
    client.setBaseUrl(null);
    client.setToken(null);
    setFirstRunRemoteConnecting(false);
    setFirstRunRemoteError(null);
    setFirstRunRemoteConnected(false);
    setFirstRunRemoteApiBase("");
    setFirstRunRemoteToken("");
    persistMobileRuntimeModeForServerTarget("");
    setFirstRunRuntimeTarget("");
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
    setFirstRunRemoteApiBase,
    setFirstRunRemoteConnected,
    setFirstRunRemoteConnecting,
    setFirstRunRemoteError,
    setFirstRunRemoteToken,
    setFirstRunRuntimeTarget,
    client,
  ]);

  // ── handleFirstRunRemoteConnect ────────────────────────────────

  const handleFirstRunRemoteConnect = useCallback(async () => {
    if (firstRunRemoteConnecting) return;
    let normalizedBase = "";
    try {
      normalizedBase = normalizeRemoteApiBaseInput(firstRunRemoteApiBase);
    } catch (err) {
      setFirstRunRemoteError(
        err instanceof Error ? err.message : "Enter a valid backend address.",
      );
      return;
    }

    const accessKey = firstRunRemoteToken.trim();
    const probe = new ElizaClient(normalizedBase, accessKey || undefined);
    setFirstRunRemoteConnecting(true);
    setFirstRunRemoteError(null);
    try {
      const auth = await probe.getAuthStatus();
      if (auth.required && !accessKey) {
        throw new Error("This backend requires an access key.");
      }
      await probe.getFirstRunStatus();
      savePersistedActiveServer(
        createPersistedActiveServer({
          kind: "remote",
          apiBase: normalizedBase,
          ...(accessKey ? { accessToken: accessKey } : {}),
        }),
      );
      persistMobileRuntimeModeForServerTarget("remote");
      setFirstRunRuntimeTarget("remote");
      setFirstRunRemoteApiBase(normalizedBase);
      setFirstRunRemoteToken(accessKey);
      setFirstRunRemoteConnected(true);
      setActionNotice("Connected to remote backend.", "success", 4200);
      retryStartup();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to reach remote backend.";
      const normalizedMessage =
        /401|unauthorized|forbidden/i.test(message) && accessKey
          ? "Access key rejected. Check the address and try again."
          : message;
      setFirstRunRemoteError(normalizedMessage);
    } finally {
      setFirstRunRemoteConnecting(false);
    }
  }, [
    firstRunRemoteApiBase,
    firstRunRemoteConnecting,
    firstRunRemoteToken,
    retryStartup,
    setActionNotice,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteConnected,
    setFirstRunRemoteConnecting,
    setFirstRunRemoteError,
    setFirstRunRemoteToken,
    setFirstRunRuntimeTarget,
  ]);

  // ── handleCloudFirstRunFinish ──────────────────────────────────

  const handleCloudFirstRunFinish = useCallback(async () => {
    await runFirstRunChatHandoff();
  }, [runFirstRunChatHandoff]);

  // ── applyDetectedProviders ───────────────────────────────────────

  const applyDetectedProviders = useCallback(
    (detected: Awaited<ReturnType<typeof scanProviderCredentials>>) => {
      setFirstRunDetectedProviders(
        detected as typeof detected & AppState["firstRunDetectedProviders"],
      );
    },
    [setFirstRunDetectedProviders],
  );

  return {
    completeFirstRun,
    runFirstRunChatHandoff,
    handleFirstRunFinish,
    goToFirstRunStep,
    applyResetConnectionWizardToHostingStep,
    advanceFirstRun,
    handleFirstRunNext,
    revertFirstRun,
    handleFirstRunBack,
    handleFirstRunJumpToStep,
    handleFirstRunUseLocalBackend,
    handleFirstRunRemoteConnect,
    handleCloudFirstRunFinish,
    applyDetectedProviders,
  };
}
