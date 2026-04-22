import type { ProviderOption } from "@elizaos/shared/contracts/onboarding";
import { ONBOARDING_PROVIDER_CATALOG } from "@elizaos/shared/contracts/onboarding";
import { useCallback, useEffect, useMemo } from "react";
import { useBranding } from "../../config/branding";
import {
  applyConnectionTransition,
  CONNECTION_RECOMMENDED_PROVIDER_IDS,
  type ConnectionEvent,
  type ConnectionFlowSnapshot,
  type ConnectionStatePatch,
  resolveConnectionUiSpec,
} from "../../onboarding/connection-flow";
import { persistMobileRuntimeModeForServerTarget } from "../../onboarding/mobile-runtime-mode";
import { isNative } from "../../platform/init";
import { useApp } from "../../state";
import type { AppState } from "../../state/types";
import { ConnectionProviderDetailScreen } from "./connection/ConnectionProviderDetailScreen";
import {
  ConnectionUiRoot,
  type ConnectionUiSharedProps,
} from "./connection/ConnectionUiRoot";

const recommendedIds = new Set<string>(CONNECTION_RECOMMENDED_PROVIDER_IDS);

const providerOverrides: Record<
  string,
  {
    nameDefault: string;
    descriptionDefault?: string;
    nameKey?: string;
    descriptionKey?: string;
  }
> = {
  elizacloud: {
    nameDefault: "Eliza Cloud",
    descriptionDefault: "Models + RPC included",
    nameKey: "onboarding.providerElizaCloud",
    descriptionKey: "onboarding.providerElizaCloudDescription",
  },
  "anthropic-subscription": {
    nameDefault: "Claude Sub",
    descriptionDefault: "Claude plan",
    nameKey: "onboarding.providerClaudeSubscription",
    descriptionKey: "onboarding.providerClaudeSubscriptionDescription",
  },
  "openai-subscription": {
    nameDefault: "ChatGPT Sub",
    descriptionDefault: "ChatGPT plan",
    nameKey: "onboarding.providerChatGPTSubscription",
    descriptionKey: "onboarding.providerChatGPTSubscriptionDescription",
  },
  anthropic: {
    nameDefault: "Anthropic",
    descriptionDefault: "Claude key",
    descriptionKey: "onboarding.providerAnthropicDescription",
  },
  openai: {
    nameDefault: "OpenAI",
    descriptionDefault: "GPT key",
    descriptionKey: "onboarding.providerOpenAIDescription",
  },
  openrouter: {
    nameDefault: "OpenRouter",
    descriptionDefault: "Many models",
    descriptionKey: "onboarding.providerOpenRouterDescription",
  },
  gemini: {
    nameDefault: "Gemini",
    descriptionDefault: "Google AI",
    descriptionKey: "onboarding.providerGeminiDescription",
  },
  grok: { nameDefault: "xAI (Grok)" },
  groq: {
    nameDefault: "Groq",
    descriptionDefault: "Fast inference",
    descriptionKey: "onboarding.providerGroqDescription",
  },
  deepseek: {
    nameDefault: "DeepSeek",
    descriptionDefault: "DeepSeek models",
    descriptionKey: "onboarding.providerDeepSeekDescription",
  },
  mistral: {
    nameDefault: "Mistral",
    descriptionDefault: "Mistral models",
    descriptionKey: "onboarding.providerMistralDescription",
  },
  together: {
    nameDefault: "Together AI",
    descriptionDefault: "OSS models",
    descriptionKey: "onboarding.providerTogetherDescription",
  },
  ollama: {
    nameDefault: "Ollama",
    descriptionDefault: "Local models",
    descriptionKey: "onboarding.providerOllamaDescription",
  },
  zai: {
    nameDefault: "z.ai",
    descriptionDefault: "GLM models",
    descriptionKey: "onboarding.providerZaiDescription",
  },
};

function applyOnboardingPatch(
  patch: ConnectionStatePatch,
  setState: <K extends keyof AppState>(key: K, value: AppState[K]) => void,
): void {
  if (patch.onboardingServerTarget !== undefined) {
    setState("onboardingServerTarget", patch.onboardingServerTarget);
  }
  if (patch.onboardingCloudApiKey !== undefined) {
    setState("onboardingCloudApiKey", patch.onboardingCloudApiKey);
  }
  if (patch.onboardingProvider !== undefined) {
    setState("onboardingProvider", patch.onboardingProvider);
  }
  if (patch.onboardingApiKey !== undefined) {
    setState("onboardingApiKey", patch.onboardingApiKey);
  }
  if (patch.onboardingPrimaryModel !== undefined) {
    setState("onboardingPrimaryModel", patch.onboardingPrimaryModel);
  }
  if (patch.onboardingRemoteApiBase !== undefined) {
    setState("onboardingRemoteApiBase", patch.onboardingRemoteApiBase);
  }
  if (patch.onboardingRemoteToken !== undefined) {
    setState("onboardingRemoteToken", patch.onboardingRemoteToken);
  }
  if (patch.onboardingRemoteError !== undefined) {
    setState("onboardingRemoteError", patch.onboardingRemoteError);
  }
  if (patch.onboardingRemoteConnecting !== undefined) {
    setState("onboardingRemoteConnecting", patch.onboardingRemoteConnecting);
  }
  if (patch.onboardingRemoteConnected !== undefined) {
    setState("onboardingRemoteConnected", patch.onboardingRemoteConnected);
  }
  if (patch.onboardingSubscriptionTab !== undefined) {
    setState("onboardingSubscriptionTab", patch.onboardingSubscriptionTab);
  }
  if (patch.onboardingElizaCloudTab !== undefined) {
    setState("onboardingElizaCloudTab", patch.onboardingElizaCloudTab);
  }
}

export function ConnectionStep() {
  const {
    onboardingStep,
    onboardingOptions,
    onboardingServerTarget,
    onboardingProvider,
    onboardingSubscriptionTab,
    onboardingElizaCloudTab,
    onboardingDetectedProviders,
    onboardingRemoteConnected,
    handleOnboardingUseLocalBackend,
    setState,
    t,
  } = useApp();
  const resolvedOnboardingServerTarget = onboardingServerTarget ?? "";

  const branding = useBranding();
  const cloudOnly = Boolean(branding.cloudOnly);
  const forceCloud = cloudOnly;

  const catalogProviders: ProviderOption[] = (
    onboardingOptions?.providers as ProviderOption[] | undefined
  )?.length
    ? (onboardingOptions?.providers as ProviderOption[])
    : ([...ONBOARDING_PROVIDER_CATALOG] as ProviderOption[]);
  const customProviders = branding.customProviders ?? [];
  const catalogIds = new Set(catalogProviders.map((p: ProviderOption) => p.id));
  const providers = [
    ...catalogProviders,
    ...customProviders.filter((cp) => !catalogIds.has(cp.id as never)),
  ] as ProviderOption[];
  const customLogoMap = new Map(
    customProviders
      .filter((cp) => cp.logoDark || cp.logoLight)
      .map((cp) => [cp.id, { logoDark: cp.logoDark, logoLight: cp.logoLight }]),
  );
  const getCustomLogo = (id: string) => customLogoMap.get(id);

  const getProviderDisplay = (provider: ProviderOption) => {
    const override = providerOverrides[provider.id];
    return {
      name:
        override?.nameKey && override?.nameDefault
          ? t(override.nameKey, { defaultValue: override.nameDefault })
          : (override?.nameDefault ?? provider.name),
      description:
        override?.descriptionKey && override?.descriptionDefault
          ? t(override.descriptionKey, {
              defaultValue: override.descriptionDefault,
            })
          : (override?.descriptionDefault ?? provider.description),
    };
  };

  const availableProviders = providers;
  const recommendedProviders = availableProviders.filter((p: ProviderOption) =>
    recommendedIds.has(p.id),
  );
  const otherProviders = availableProviders.filter(
    (p: ProviderOption) => !recommendedIds.has(p.id),
  );
  const sortedProviders = [...recommendedProviders, ...otherProviders];

  const detectedByProviderId = new Map(
    (onboardingDetectedProviders ?? []).map((d) => [d.id, d]),
  );

  const getDetectedLabel = (providerId: string): string | null => {
    const d = detectedByProviderId.get(providerId);
    if (!d) return null;
    if (d.source === "codex-auth") {
      return t("onboarding.detectedFromCodex", {
        defaultValue: "Detected from Codex",
      });
    }
    if (d.source === "claude-credentials") {
      return t("onboarding.detectedFromClaudeCode", {
        defaultValue: "Detected from Claude Code",
      });
    }
    if (d.source === "keychain") {
      return t("onboarding.detectedFromKeychain", {
        defaultValue: "Detected from Keychain",
      });
    }
    if (d.source === "env") {
      return t("onboarding.detectedFromEnv", {
        defaultValue: "Detected from env",
      });
    }
    return t("onboarding.autoDetected", { defaultValue: "Auto-detected" });
  };

  const connectionSnapshot: ConnectionFlowSnapshot = useMemo(
    () => ({
      onboardingServerTarget: resolvedOnboardingServerTarget,
      onboardingProvider,
      onboardingRemoteConnected,
      onboardingElizaCloudTab,
      onboardingSubscriptionTab,
      forceCloud,
      isNative,
      cloudOnly,
      onboardingDetectedProviders: onboardingDetectedProviders ?? [],
    }),
    [
      resolvedOnboardingServerTarget,
      onboardingProvider,
      onboardingRemoteConnected,
      onboardingElizaCloudTab,
      onboardingSubscriptionTab,
      forceCloud,
      cloudOnly,
      onboardingDetectedProviders,
    ],
  );

  const spec = useMemo(
    () => resolveConnectionUiSpec(connectionSnapshot),
    [connectionSnapshot],
  );

  const dispatchConnection = useCallback(
    (event: ConnectionEvent) => {
      const result = applyConnectionTransition(connectionSnapshot, event);
      if (!result) return;
      if (result.kind === "effect") {
        if (result.effect === "useLocalBackend") {
          void handleOnboardingUseLocalBackend();
        }
        return;
      }
      if (result.patch.onboardingServerTarget !== undefined) {
        persistMobileRuntimeModeForServerTarget(
          result.patch.onboardingServerTarget,
        );
      }
      applyOnboardingPatch(result.patch, setState);
    },
    [connectionSnapshot, handleOnboardingUseLocalBackend, setState],
  );

  useEffect(() => {
    if (!forceCloud || resolvedOnboardingServerTarget) return;
    const snap: ConnectionFlowSnapshot = {
      onboardingServerTarget: resolvedOnboardingServerTarget,
      onboardingProvider,
      onboardingRemoteConnected,
      onboardingElizaCloudTab,
      onboardingSubscriptionTab,
      forceCloud,
      isNative,
      cloudOnly,
      onboardingDetectedProviders: onboardingDetectedProviders ?? [],
    };
    const result = applyConnectionTransition(snap, {
      type: "forceCloudBootstrap",
    });
    if (result?.kind === "patch") {
      if (result.patch.onboardingServerTarget !== undefined) {
        persistMobileRuntimeModeForServerTarget(
          result.patch.onboardingServerTarget,
        );
      }
      applyOnboardingPatch(result.patch, setState);
    }
  }, [
    forceCloud,
    resolvedOnboardingServerTarget,
    onboardingProvider,
    onboardingRemoteConnected,
    onboardingElizaCloudTab,
    onboardingSubscriptionTab,
    cloudOnly,
    onboardingDetectedProviders,
    setState,
  ]);

  useEffect(() => {
    if (onboardingStep !== "providers") {
      setState("onboardingStep", "providers");
    }
  }, [onboardingStep, setState]);

  const shared: ConnectionUiSharedProps = {
    dispatch: dispatchConnection,
    onTransitionEffect: (effect) => {
      if (effect === "useLocalBackend") {
        void handleOnboardingUseLocalBackend();
      }
    },
    sortedProviders,
    getProviderDisplay,
    getCustomLogo,
    getDetectedLabel,
  };

  return (
    <div className="relative h-full w-full">
      <ConnectionUiRoot
        spec={spec}
        shared={shared}
        providerDetail={
          <ConnectionProviderDetailScreen dispatch={dispatchConnection} />
        }
      />
    </div>
  );
}
