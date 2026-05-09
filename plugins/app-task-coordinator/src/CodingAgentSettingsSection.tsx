import { type AgentPreflightResult, client, useApp } from "@elizaos/ui";
import { ExternalLink, Terminal } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AgentTabsSection } from "./AgentTabsSection";
import {
  ADAPTER_NAME_TO_TAB,
  AGENT_LABELS,
  AGENT_PROVIDER_MAP,
  AGENT_TABS,
  type AgentSelectionStrategy,
  type AgentTab,
  AIDER_MODELS,
  AIDER_PROVIDER_MAP,
  type AiderProvider,
  type ApprovalPreset,
  type AuthResult,
  ENV_PREFIX,
  FALLBACK_MODELS,
  type LlmProvider,
  type ModelOption,
} from "./coding-agent-settings-shared";
import { GitHubConnectionCard } from "./GitHubConnectionCard";
import { GlobalPrefsSection } from "./GlobalPrefsSection";
import { LlmProviderSection } from "./LlmProviderSection";
import { ModelConfigSection } from "./ModelConfigSection";

function AgentAdvancedSettingsDisclosure({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <details className="group rounded-xl border border-border/60 bg-card/45 px-3 py-2">
      <summary className="cursor-pointer select-none list-none text-xs font-semibold uppercase tracking-wide text-muted transition-colors hover:text-txt">
        Defaults and workspace
      </summary>
      <div className="mt-3 flex flex-col gap-4 border-t border-border/40 pt-3">
        {children}
      </div>
    </details>
  );
}

export function CodingAgentSettingsSection() {
  const { t, elizaCloudConnected } = useApp();

  const [activeTab, setActiveTab] = useState<AgentTab | null>(null);
  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = useState<Record<string, string>>({});
  const [providerModels, setProviderModels] = useState<
    Record<string, ModelOption[]>
  >({});
  const [preflightLoaded, setPreflightLoaded] = useState(false);
  const [preflightByAgent, setPreflightByAgent] = useState<
    Partial<Record<AgentTab, AgentPreflightResult>>
  >({});
  const [authInProgress, setAuthInProgress] = useState<AgentTab | null>(null);
  const [authResult, setAuthResult] = useState<AuthResult | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      try {
        const [cfg, anthropicRes, googleRes, openaiRes, preflightRes] =
          await Promise.all([
            client.getConfig(),
            client.fetchModels("anthropic", false).catch(() => null),
            client.fetchModels("google-genai", false).catch(() => null),
            client.fetchModels("openai", false).catch(() => null),
            fetch("/api/coding-agents/preflight", {
              signal: controller.signal,
            })
              .then((response) => (response.ok ? response.json() : null))
              .catch(() => null),
          ]);

        if (controller.signal.aborted) return;

        const env = (cfg.env ?? {}) as Record<string, string>;
        const cloud = (cfg.cloud ?? {}) as Record<string, string>;
        const loaded: Record<string, string> = {};
        // Store cloud API key for reference in cloud mode
        if (cloud.apiKey) {
          loaded._CLOUD_API_KEY = cloud.apiKey;
        }
        for (const agent of ["CLAUDE", "GEMINI", "CODEX", "AIDER"] as const) {
          const prefix = `PARALLAX_${agent}`;
          if (env[`${prefix}_MODEL_POWERFUL`]) {
            loaded[`${prefix}_MODEL_POWERFUL`] =
              env[`${prefix}_MODEL_POWERFUL`];
          }
          if (env[`${prefix}_MODEL_FAST`]) {
            loaded[`${prefix}_MODEL_FAST`] = env[`${prefix}_MODEL_FAST`];
          }
        }
        for (const k of [
          "PARALLAX_AIDER_PROVIDER",
          "PARALLAX_DEFAULT_APPROVAL_PRESET",
          "PARALLAX_AGENT_SELECTION_STRATEGY",
          "PARALLAX_DEFAULT_AGENT_TYPE",
          "PARALLAX_SCRATCH_RETENTION",
          "PARALLAX_CODING_DIRECTORY",
          "PARALLAX_LLM_PROVIDER",
        ] as const) {
          if (env[k]) loaded[k] = env[k];
        }
        // API keys — load presence indicators (masked)
        for (const key of [
          "ANTHROPIC_API_KEY",
          "OPENAI_API_KEY",
          "GOOGLE_GENERATIVE_AI_API_KEY",
          "ANTHROPIC_BASE_URL",
          "OPENAI_BASE_URL",
        ] as const) {
          if (env[key]) loaded[key] = env[key];
        }
        setPrefs(loaded);

        const models: Record<string, ModelOption[]> = {};
        for (const [providerId, response] of [
          ["anthropic", anthropicRes],
          ["google-genai", googleRes],
          ["openai", openaiRes],
        ] as const) {
          if (
            response?.models &&
            Array.isArray(response.models) &&
            response.models.length > 0
          ) {
            const chatModels = response.models
              .filter((model) => model.category === "chat")
              .map((model) => ({
                value: model.id,
                label: model.name || model.id,
              }));
            if (chatModels.length > 0) {
              models[providerId] = chatModels;
            }
          }
        }
        setProviderModels(models);

        if (Array.isArray(preflightRes)) {
          const mapped: Partial<Record<AgentTab, AgentPreflightResult>> = {};
          for (const item of preflightRes) {
            const raw = item.adapter?.toLowerCase();
            const key = raw ? ADAPTER_NAME_TO_TAB[raw] : undefined;
            if (key) {
              mapped[key] = item;
            }
          }
          setPreflightByAgent(mapped);
          setPreflightLoaded(true);
        }
      } catch (err) {
        // Fall back to built-in defaults when config or model fetches fail —
        // the panel still renders with FALLBACK_MODELS so the user isn't
        // blocked. Log so a real failure isn't completely silent.
        console.warn(
          "[coding-agents] Failed to load config/models on mount",
          err,
        );
      }
      if (!controller.signal.aborted) setLoading(false);
    })();
    return () => controller.abort();
  }, []);

  // If the user previously chose "cloud" but Eliza Cloud has since been
  // disconnected, fall back to "subscription" rather than leaving the
  // selector pointed at an unusable provider.
  const rawLlmProvider = (prefs.PARALLAX_LLM_PROVIDER ||
    "subscription") as LlmProvider;
  const llmProvider: LlmProvider =
    rawLlmProvider === "cloud" && !elizaCloudConnected
      ? "subscription"
      : rawLlmProvider;
  const isCloud = llmProvider === "cloud";

  const installedAgents = AGENT_TABS.filter(
    (agent) => preflightByAgent[agent]?.installed === true,
  );
  // Gemini CLI can't route through cloud (no Google-native proxy)
  const providerFilteredAgents = isCloud
    ? AGENT_TABS.filter((agent) => agent !== "gemini")
    : AGENT_TABS;
  const availableAgents =
    preflightLoaded && installedAgents.length > 0
      ? installedAgents.filter((a) => providerFilteredAgents.includes(a))
      : providerFilteredAgents;

  const getInstallState = (
    agent: AgentTab,
  ): "installed" | "missing" | "unknown" => {
    if (!preflightLoaded) {
      return "unknown";
    }
    return preflightByAgent[agent]?.installed ? "installed" : "missing";
  };

  useEffect(() => {
    if (loading || availableAgents.length === 0) return;
    if (activeTab === null) {
      const saved = prefs.PARALLAX_DEFAULT_AGENT_TYPE as AgentTab | undefined;
      setActiveTab(
        saved && availableAgents.includes(saved) ? saved : availableAgents[0],
      );
    } else if (!availableAgents.includes(activeTab)) {
      setActiveTab(availableAgents[0]);
    }
  }, [loading, activeTab, availableAgents, prefs.PARALLAX_DEFAULT_AGENT_TYPE]);

  // `setPref` is a pure state updater. It must NOT perform network I/O
  // inside `setPrefs((prev) => ...)` — React may invoke state updaters
  // twice in Strict Mode, which would double every auto-save write.
  // The actual persist is handled by the debounced effect below.
  const setPref = useCallback((key: string, value: string) => {
    setPrefs((previous) => ({ ...previous, [key]: value }));
  }, []);

  // Debounced auto-save. Coalesces rapid keystrokes (e.g. typing an
  // API key character-by-character) into a single POST so we don't
  // persist 40+ partial-key snapshots to `eliza.json` and don't
  // leave the config in a half-written state if one request fails
  // mid-flight.
  //
  // Filter out `_`-prefixed synthetic keys that we load from non-env
  // sources (e.g. `_CLOUD_API_KEY` is loaded from `config.cloud.apiKey`)
  // — writing them back into `config.env` would leak the cloud API key
  // into the env surface, duplicating it and creating a second read
  // path that bypasses the `cloud.apiKey` contract.
  //
  // `.catch()` surfaces failed saves in an inline error banner so a
  // failed POST no longer silently drops the user's typed API key on
  // restart. (SaveFooter used to own this surface; we replaced it with
  // debounced auto-save and lost the error-feedback path until now.)
  const [autoSaveError, setAutoSaveError] = useState<string | null>(null);
  const autoSaveArmedRef = useRef(false);
  useEffect(() => {
    if (loading) return;
    if (!autoSaveArmedRef.current) {
      autoSaveArmedRef.current = true;
      return;
    }
    const envPatch: Record<string, string> = {};
    for (const [k, v] of Object.entries(prefs)) {
      if (k.startsWith("_")) continue;
      if (typeof v === "string") {
        envPatch[k] = v;
      } else if (typeof v === "number" || typeof v === "boolean") {
        envPatch[k] = String(v);
      }
    }
    const timer = setTimeout(() => {
      client
        .updateConfig({ env: envPatch })
        .then(() => setAutoSaveError(null))
        .catch((err: unknown) => {
          setAutoSaveError(
            err instanceof Error ? err.message : "Failed to save settings",
          );
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [prefs, loading]);

  // Reset Aider provider to anthropic if cloud is selected and google was chosen
  useEffect(() => {
    if (isCloud && prefs.PARALLAX_AIDER_PROVIDER === "google") {
      setPref("PARALLAX_AIDER_PROVIDER", "anthropic");
    }
  }, [isCloud, prefs.PARALLAX_AIDER_PROVIDER, setPref]);

  const refreshPreflight = useCallback(async () => {
    try {
      const preflightRes = await fetch("/api/coding-agents/preflight");
      if (!preflightRes.ok) return null;
      const results = await preflightRes.json();
      if (!Array.isArray(results)) return null;
      const mapped: Partial<Record<AgentTab, AgentPreflightResult>> = {};
      for (const item of results as AgentPreflightResult[]) {
        const raw = item.adapter?.toLowerCase();
        const key = raw ? ADAPTER_NAME_TO_TAB[raw] : undefined;
        if (key) mapped[key] = item;
      }
      setPreflightByAgent(mapped);
      return mapped;
    } catch (err) {
      console.warn("[coding-agents] Failed to refresh preflight", err);
      return null;
    }
  }, []);

  // Ref to any in-flight auth-polling interval so we can cancel it on
  // unmount or when a new auth flow starts. Without this, closing the
  // settings panel while a poll is active leaks a network-request loop.
  const authPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (authPollRef.current !== null) {
        clearInterval(authPollRef.current);
        authPollRef.current = null;
      }
    };
  }, []);

  const handleAuth = useCallback(
    async (agent: AgentTab) => {
      if (authPollRef.current !== null) {
        clearInterval(authPollRef.current);
        authPollRef.current = null;
      }
      setAuthInProgress(agent);
      setAuthResult(null);
      try {
        const res = await fetch(`/api/coding-agents/auth/${agent}`, {
          method: "POST",
        });
        if (!res.ok) {
          setAuthResult({
            agent,
            launched: false,
            instructions: `Failed to start auth (${res.status}). Try again, or run the CLI's login command directly.`,
          });
          setAuthInProgress(null);
          return;
        }
        const data = await res.json();
        setAuthResult({ agent, ...data });
        let attempts = 0;
        const maxAttempts = 40;
        const poll = setInterval(async () => {
          attempts++;
          const mapped = await refreshPreflight();
          const authed = mapped?.[agent]?.auth?.status === "authenticated";
          if (authed || attempts >= maxAttempts) {
            clearInterval(poll);
            if (authPollRef.current === poll) authPollRef.current = null;
            setAuthInProgress(null);
            if (authed) setAuthResult(null);
          }
        }, 3000);
        authPollRef.current = poll;
      } catch (err) {
        setAuthResult({
          agent,
          launched: false,
          instructions:
            err instanceof Error
              ? `Auth request failed: ${err.message}`
              : "Auth request failed. Try again, or run the CLI's login command directly.",
        });
        setAuthInProgress(null);
      }
    },
    [refreshPreflight],
  );

  const getProviderId = (
    tab: AgentTab,
    aiderProvider: AiderProvider,
  ): string =>
    tab === "aider"
      ? AIDER_PROVIDER_MAP[aiderProvider]
      : AGENT_PROVIDER_MAP[tab];

  const getModelOptions = (providerId: string): ModelOption[] => {
    // Aider uses short aliases, not full model IDs
    if (activeTab === "aider") {
      return AIDER_MODELS[providerId] ?? [];
    }
    return providerModels[providerId] ?? FALLBACK_MODELS[providerId] ?? [];
  };

  if (loading || !activeTab) {
    return (
      <div className="py-4 text-center text-muted text-xs">
        {t("codingagentsettingssection.LoadingCodingAgent")}
      </div>
    );
  }

  const prefix = ENV_PREFIX[activeTab];
  const aiderProvider = (prefs.PARALLAX_AIDER_PROVIDER ||
    "anthropic") as AiderProvider;
  const providerId = getProviderId(activeTab, aiderProvider);
  const modelOptions = getModelOptions(providerId);
  const powerfulValue = prefs[`${prefix}_MODEL_POWERFUL`] ?? "";
  const fastValue = prefs[`${prefix}_MODEL_FAST`] ?? "";
  const isDynamic = Boolean(providerModels[providerId]);
  const selectionStrategy = (prefs.PARALLAX_AGENT_SELECTION_STRATEGY ||
    "fixed") as AgentSelectionStrategy;
  const approvalPreset = (prefs.PARALLAX_DEFAULT_APPROVAL_PRESET ||
    "permissive") as ApprovalPreset;

  if (preflightLoaded && installedAgents.length === 0) {
    return (
      <div className="flex flex-col gap-2 text-xs text-muted">
        <div>{t("codingagentsettingssection.NoSupportedCLIs")}</div>
        <div className="grid gap-2">
          {AGENT_TABS.map((agent) => {
            const preflight = preflightByAgent[agent];
            return (
              <div
                key={agent}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-card/40 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-txt">
                    {AGENT_LABELS[agent]}
                  </div>
                  {preflight?.installCommand ? (
                    <code className="inline-flex max-w-full items-center gap-1 truncate rounded border border-border/50 bg-bg px-1.5 py-0.5 text-2xs text-muted-strong">
                      <Terminal className="h-3 w-3 shrink-0" aria-hidden />
                      <span className="truncate">
                        {preflight.installCommand}
                      </span>
                    </code>
                  ) : null}
                </div>
                {preflight?.docsUrl ? (
                  <a
                    href={preflight.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-bg-hover hover:text-txt"
                    aria-label={`${AGENT_LABELS[agent]} docs`}
                    title={`${AGENT_LABELS[agent]} docs`}
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </a>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {autoSaveError && (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {t("codingagentsettingssection.AutoSaveFailed", {
            defaultValue: "Failed to save settings: {{error}}",
            error: autoSaveError,
          })}
        </div>
      )}

      <AgentTabsSection
        activeTab={activeTab}
        availableAgents={availableAgents}
        llmProvider={llmProvider}
        preflightByAgent={preflightByAgent}
        authInProgress={authInProgress}
        authResult={authResult}
        getInstallState={getInstallState}
        onSelectAgent={(agent) => {
          setActiveTab(agent);
          setPref("PARALLAX_DEFAULT_AGENT_TYPE", agent);
        }}
        onAuth={handleAuth}
      />

      <LlmProviderSection
        llmProvider={llmProvider}
        isCloud={isCloud}
        prefs={prefs}
        setPref={setPref}
      />

      <ModelConfigSection
        activeTab={activeTab}
        llmProvider={llmProvider}
        isCloud={isCloud}
        aiderProvider={aiderProvider}
        prefix={prefix}
        powerfulValue={powerfulValue}
        fastValue={fastValue}
        modelOptions={modelOptions}
        isDynamic={isDynamic}
        setPref={setPref}
      />

      <GitHubConnectionCard />

      <AgentAdvancedSettingsDisclosure>
        <GlobalPrefsSection
          prefs={prefs}
          selectionStrategy={selectionStrategy}
          approvalPreset={approvalPreset}
          setPref={setPref}
        />
      </AgentAdvancedSettingsDisclosure>
    </div>
  );
}
