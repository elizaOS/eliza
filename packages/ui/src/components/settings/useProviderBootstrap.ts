import {
  resolveServiceRoutingInConfig,
  type SubscriptionProviderStatus,
} from "@elizaos/shared";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";
import { client } from "../../api";
import { getOnboardingProviderOption } from "../../providers";
import type { useCloudModelConfig } from "./useCloudModelConfig";
import type { useProviderSelection } from "./useProviderSelection";

export interface ProviderBootstrapState {
  subscriptionStatus: SubscriptionProviderStatus[];
  anthropicConnected: boolean;
  setAnthropicConnected: Dispatch<SetStateAction<boolean>>;
  anthropicCliDetected: boolean;
  openaiConnected: boolean;
  setOpenaiConnected: Dispatch<SetStateAction<boolean>>;
  loadSubscriptionStatus: () => Promise<void>;
}

export function useProviderBootstrap(
  selection: ReturnType<typeof useProviderSelection>,
  cloudModel: ReturnType<typeof useCloudModelConfig>,
): ProviderBootstrapState {
  const [subscriptionStatus, setSubscriptionStatus] = useState<
    SubscriptionProviderStatus[]
  >([]);
  const [anthropicConnected, setAnthropicConnected] = useState(false);
  const [anthropicCliDetected, setAnthropicCliDetected] = useState(false);
  const [openaiConnected, setOpenaiConnected] = useState(false);

  const loadSubscriptionStatus = useCallback(async () => {
    try {
      const res = await client.getSubscriptionStatus();
      setSubscriptionStatus(res.providers ?? []);
    } catch (err) {
      console.warn("[eliza] Failed to load subscription status", err);
    }
  }, []);

  // Boot effect. Hooks own their internal state; calling their stable
  // setters in this once-on-mount effect is intentional. Biome wants the
  // setter identities in the dep list but we know they're stable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable hook setters
  useEffect(() => {
    void loadSubscriptionStatus();
    void (async () => {
      try {
        const opts = await client.getOnboardingOptions();
        cloudModel.setModelOptions({
          nano: opts.models?.nano ?? [],
          small: opts.models?.small ?? [],
          medium: opts.models?.medium ?? [],
          large: opts.models?.large ?? [],
          mega: opts.models?.mega ?? [],
        });
      } catch (err) {
        console.warn("[eliza] Failed to load onboarding options", err);
      }
      try {
        const cfg = await client.getConfig();
        const llmText = resolveServiceRoutingInConfig(cfg)?.llmText;
        const providerId = getOnboardingProviderOption(llmText?.backend)?.id;
        const elizaCloudEnabledCfg =
          llmText?.transport === "cloud-proxy" && providerId === "elizacloud";
        cloudModel.initializeFromConfig(cfg, elizaCloudEnabledCfg);
        selection.initializeFromConfig(cfg);
      } catch (err) {
        console.warn("[eliza] Failed to load config", err);
      }
    })();
  }, [loadSubscriptionStatus]);

  useEffect(() => {
    const anthStatuses = subscriptionStatus.filter(
      (s) => s.provider === "anthropic-subscription",
    );
    const oaiStatuses = subscriptionStatus.filter(
      (s) =>
        s.provider === "openai-subscription" || s.provider === "openai-codex",
    );
    // Only treat as "connected" when credentials were linked via the in-app
    // OAuth flow (source === "app"). Claude Code CLI credentials detected on
    // the machine are surfaced separately — the app can't disconnect them.
    const anthAppConnected = anthStatuses.some(
      (status) => status.configured && status.valid && status.source === "app",
    );
    setAnthropicConnected(anthAppConnected);
    setAnthropicCliDetected(
      anthStatuses.some(
        (status) =>
          status.configured &&
          status.valid &&
          status.source === "claude-code-cli",
      ),
    );
    setOpenaiConnected(
      oaiStatuses.some((status) => status.configured && status.valid),
    );
  }, [subscriptionStatus]);

  return {
    subscriptionStatus,
    anthropicConnected,
    setAnthropicConnected,
    anthropicCliDetected,
    openaiConnected,
    setOpenaiConnected,
    loadSubscriptionStatus,
  };
}
