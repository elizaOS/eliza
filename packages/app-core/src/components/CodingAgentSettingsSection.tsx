import { Button } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import type { AgentPreflightResult } from "../api";
import { client } from "../api";
import { useTimeout } from "../hooks";
import { useApp } from "../state";
import { ConfigSaveFooter } from "./ConfigSaveFooter";

type AgentTab = "claude" | "gemini" | "codex" | "aider";
type AiderProvider = "anthropic" | "openai" | "google";
type ApprovalPreset = "readonly" | "standard" | "permissive" | "autonomous";
type AgentSelectionStrategy = "fixed" | "ranked";

const AGENT_TABS: AgentTab[] = ["claude", "gemini", "codex", "aider"];

const APPROVAL_PRESETS: {
  value: ApprovalPreset;
  labelKey: string;
  descKey: string;
}[] = [
    {
      value: "readonly",
      labelKey: "codingagentsettingssection.PresetReadOnly",
      descKey: "codingagentsettingssection.PresetReadOnlyDesc",
    },
    {
      value: "standard",
      labelKey: "codingagentsettingssection.PresetStandard",
      descKey: "codingagentsettingssection.PresetStandardDesc",
    },
    {
      value: "permissive",
      labelKey: "codingagentsettingssection.PresetPermissive",
      descKey: "codingagentsettingssection.PresetPermissiveDesc",
    },
    {
      value: "autonomous",
      labelKey: "codingagentsettingssection.PresetAutonomous",
      descKey: "codingagentsettingssection.PresetAutonomousDesc",
    },
  ];

interface ModelOption {
  value: string;
  label: string;
}

const AGENT_PROVIDER_MAP: Record<AgentTab, string> = {
  claude: "anthropic",
  gemini: "google-genai",
  codex: "openai",
  aider: "anthropic",
};

const AIDER_PROVIDER_MAP: Record<AiderProvider, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google-genai",
};

const FALLBACK_MODELS: Record<string, ModelOption[]> = {
  anthropic: [
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  "google-genai": [
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
  openai: [
    { value: "o3", label: "o3" },
    { value: "o4-mini", label: "o4-mini" },
    { value: "gpt-4o", label: "GPT-4o" },
  ],
};

const AGENT_LABELS: Record<AgentTab, string> = {
  claude: "Claude",
  gemini: "Gemini",
  codex: "Codex",
  aider: "Aider",
};

/** Map full adapter names from the preflight API to short tab keys. */
export const ADAPTER_NAME_TO_TAB: Record<string, AgentTab> = {
  "claude code": "claude",
  "google gemini": "gemini",
  "openai codex": "codex",
  aider: "aider",
  claude: "claude",
  gemini: "gemini",
  codex: "codex",
};

const ENV_PREFIX: Record<AgentTab, string> = {
  claude: "PARALLAX_CLAUDE",
  gemini: "PARALLAX_GEMINI",
  codex: "PARALLAX_CODEX",
  aider: "PARALLAX_AIDER",
};

export function CodingAgentSettingsSection() {
  const { setTimeout } = useTimeout();
  const { t } = useApp();

  const [activeTab, setActiveTab] = useState<AgentTab>("claude");
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Record<string, string>>({});
  const [providerModels, setProviderModels] = useState<
    Record<string, ModelOption[]>
  >({});
  const [preflightLoaded, setPreflightLoaded] = useState(false);
  const [preflightByAgent, setPreflightByAgent] = useState<
    Partial<Record<AgentTab, AgentPreflightResult>>
  >({});

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const [cfg, anthropicRes, googleRes, openaiRes, preflightRes] =
          await Promise.all([
            client.getConfig(),
            client.fetchModels("anthropic", false).catch(() => null),
            client.fetchModels("google-genai", false).catch(() => null),
            client.fetchModels("openai", false).catch(() => null),
            fetch("/api/coding-agents/preflight")
              .then((response) => (response.ok ? response.json() : null))
              .catch(() => null),
          ]);

        const env = (cfg.env ?? {}) as Record<string, string>;
        const loaded: Record<string, string> = {};
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
        if (env.PARALLAX_AIDER_PROVIDER) {
          loaded.PARALLAX_AIDER_PROVIDER = env.PARALLAX_AIDER_PROVIDER;
        }
        if (env.PARALLAX_DEFAULT_APPROVAL_PRESET) {
          loaded.PARALLAX_DEFAULT_APPROVAL_PRESET =
            env.PARALLAX_DEFAULT_APPROVAL_PRESET;
        }
        if (env.PARALLAX_AGENT_SELECTION_STRATEGY) {
          loaded.PARALLAX_AGENT_SELECTION_STRATEGY =
            env.PARALLAX_AGENT_SELECTION_STRATEGY;
        }
        if (env.PARALLAX_DEFAULT_AGENT_TYPE) {
          loaded.PARALLAX_DEFAULT_AGENT_TYPE = env.PARALLAX_DEFAULT_AGENT_TYPE;
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
            const chatModels = (
              response.models as Array<{
                id: string;
                name: string;
                category: string;
              }>
            )
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
          for (const item of preflightRes as AgentPreflightResult[]) {
            const raw = item.adapter?.toLowerCase();
            const key = raw ? ADAPTER_NAME_TO_TAB[raw] : undefined;
            if (key) {
              mapped[key] = item;
            }
          }
          setPreflightByAgent(mapped);
          setPreflightLoaded(true);
        }
      } catch {
        // Fall back to built-in defaults when config or model fetches fail.
      }
      setLoading(false);
    })();
  }, []);

  const installedAgents = AGENT_TABS.filter(
    (agent) => preflightByAgent[agent]?.installed === true,
  );
  const availableAgents =
    preflightLoaded && installedAgents.length > 0
      ? installedAgents
      : AGENT_TABS;

  const getInstallState = (
    agent: AgentTab,
  ): "installed" | "missing" | "unknown" => {
    if (!preflightLoaded) {
      return "unknown";
    }
    return preflightByAgent[agent]?.installed ? "installed" : "missing";
  };

  useEffect(() => {
    if (availableAgents.length === 0) {
      return;
    }
    if (!availableAgents.includes(activeTab)) {
      setActiveTab(availableAgents[0]);
    }
  }, [activeTab, availableAgents]);

  const setPref = useCallback((key: string, value: string) => {
    setPrefs((previous) => ({ ...previous, [key]: value }));
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const envPatch: Record<string, string> = {};
      for (const [key, value] of Object.entries(prefs)) {
        if (value) {
          envPatch[key] = value;
        }
      }
      await client.updateConfig({ env: envPatch });
      setDirty(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save");
    }
    setSaving(false);
  }, [prefs, setTimeout]);

  const getProviderId = (
    tab: AgentTab,
    aiderProvider: AiderProvider,
  ): string =>
    tab === "aider"
      ? AIDER_PROVIDER_MAP[aiderProvider]
      : AGENT_PROVIDER_MAP[tab];

  const getModelOptions = (providerId: string): ModelOption[] =>
    providerModels[providerId] ?? FALLBACK_MODELS[providerId] ?? [];

  if (loading) {
    return (
      <div className="py-4 text-center text-[var(--muted)] text-xs">
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
  const approvalPreset = (prefs.PARALLAX_DEFAULT_APPROVAL_PRESET ||
    "permissive") as ApprovalPreset;
  const selectionStrategy = (prefs.PARALLAX_AGENT_SELECTION_STRATEGY ||
    "fixed") as AgentSelectionStrategy;
  const defaultAgentType = (prefs.PARALLAX_DEFAULT_AGENT_TYPE ||
    "claude") as AgentTab;
  const effectiveDefaultAgentType = availableAgents.includes(defaultAgentType)
    ? defaultAgentType
    : availableAgents[0];

  if (preflightLoaded && installedAgents.length === 0) {
    return (
      <div className="flex flex-col gap-2 text-xs">
        <div className="text-[var(--muted)]">
          {t("codingagentsettingssection.NoSupportedCLIs")}
        </div>
        <div className="flex flex-col gap-1 text-[11px] text-[var(--muted)]">
          {AGENT_TABS.map((agent) => {
            const preflight = preflightByAgent[agent];
            return (
              <div key={agent}>
                <span className="font-semibold">{AGENT_LABELS[agent]}:</span>{" "}
                {preflight?.installCommand
                  ? `${t("codingagentsettingssection.InstallWith", {
                    defaultValue: "Install with",
                  })} ${preflight.installCommand}`
                  : ""}
                {preflight?.docsUrl ? ` (${preflight.docsUrl})` : ""}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold">
          {t("codingagentsettingssection.AgentSelectionStra")}
        </span>
        <select
          className="px-2.5 py-1.5 border border-border bg-card text-xs focus:border-accent focus:outline-none shadow-sm rounded-lg"
          value={selectionStrategy}
          onChange={(event) =>
            setPref("PARALLAX_AGENT_SELECTION_STRATEGY", event.target.value)
          }
        >
          <option value="fixed">{t("codingagentsettingssection.Fixed")}</option>
          <option value="ranked">
            {t("codingagentsettingssection.RankedAutoSelect")}
          </option>
        </select>
        <div className="text-[11px] text-[var(--muted)] mt-1.5">
          {selectionStrategy === "fixed"
            ? t("codingagentsettingssection.AgentUsedWhenNoEStrategyFixed")
            : t("codingagentsettingssection.AgentUsedWhenNoEStrategyRanked")}
        </div>
      </div>

      {selectionStrategy === "fixed" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">
            {t("codingagentsettingssection.DefaultAgentType")}
          </span>
          <select
            className="px-2.5 py-1.5 border border-border bg-card text-xs focus:border-accent focus:outline-none shadow-sm rounded-lg"
            value={effectiveDefaultAgentType}
            onChange={(event) =>
              setPref("PARALLAX_DEFAULT_AGENT_TYPE", event.target.value)
            }
          >
            {availableAgents.map((agent) => (
              <option key={agent} value={agent}>
                {AGENT_LABELS[agent]}
              </option>
            ))}
          </select>
          <div className="text-[11px] text-[var(--muted)]">
            {t("codingagentsettingssection.AgentUsedWhenNoE")}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold">
          {t("codingagentsettingssection.DefaultPermissionL")}
        </span>
        <select
          className="px-2.5 py-1.5 border border-border bg-card text-xs focus:border-accent focus:outline-none shadow-sm rounded-lg"
          value={approvalPreset}
          onChange={(event) =>
            setPref("PARALLAX_DEFAULT_APPROVAL_PRESET", event.target.value)
          }
        >
          {APPROVAL_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {t(preset.labelKey)}
            </option>
          ))}
        </select>
        <div className="text-[11px] text-[var(--muted)] mt-1.5">
          {APPROVAL_PRESETS.find((preset) => preset.value === approvalPreset)
            ?.descKey
            ? t(
              APPROVAL_PRESETS.find(
                (preset) => preset.value === approvalPreset,
              )?.descKey ?? "",
            )
            : ""}
          {t("codingagentsettingssection.AppliesToAllNewlySpawned")}
        </div>
      </div>

      <div className="flex gap-1 rounded-xl border border-border bg-card/50 p-1 shrink-0">
        {availableAgents.map((agent) => {
          const active = activeTab === agent;
          const installState = getInstallState(agent);
          return (
            <Button
              key={agent}
              variant={active ? "default" : "ghost"}
              size="sm"
              className={`flex-1 h-9 rounded-lg border border-transparent px-3 py-2 text-xs font-semibold ${active
                  ? "bg-accent text-accent-foreground shadow-sm"
                  : "text-muted hover:bg-bg-hover hover:text-txt"
                }`}
              onClick={() => setActiveTab(agent)}
            >
              <span className="inline-flex items-center gap-1.5">
                <span>{AGENT_LABELS[agent]}</span>
                {installState === "installed" && (
                  <span className="text-[10px] font-medium opacity-80">
                    {t("codingagentsettingssection.Installed")}
                  </span>
                )}
                {installState === "unknown" && (
                  <span className="text-[10px] font-medium opacity-70">
                    {t("codingagentsettingssection.Unknown")}
                  </span>
                )}
              </span>
            </Button>
          );
        })}
      </div>

      {preflightLoaded && (
        <div className="text-[11px] text-[var(--muted)] mt-1.5">
          {t("codingagentsettingssection.Availability")}{" "}
          {AGENT_TABS.map((agent) => {
            const installState = getInstallState(agent);
            const label =
              installState === "installed"
                ? t("codingagentsettingssection.Installed")
                : installState === "missing"
                  ? t("codingagentsettingssection.NotInstalled")
                  : t("codingagentsettingssection.Unknown");
            return `${AGENT_LABELS[agent]}: ${label}`;
          }).join(" · ")}
        </div>
      )}

      {activeTab === "aider" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">
            {t("codingagentsettingssection.Provider")}
          </span>
          <select
            className="px-2.5 py-1.5 border border-border bg-card text-xs focus:border-accent focus:outline-none shadow-sm rounded-lg"
            value={aiderProvider}
            onChange={(event) =>
              setPref("PARALLAX_AIDER_PROVIDER", event.target.value)
            }
          >
            <option value="anthropic">
              {t("codingagentsettingssection.Anthropic")}
            </option>
            <option value="openai">
              {t("codingagentsettingssection.OpenAI")}
            </option>
            <option value="google">
              {t("codingagentsettingssection.Google")}
            </option>
          </select>
        </div>
      )}

      <div className="flex gap-3">
        <div className="flex-1 flex flex-col gap-1.5">
          <span className="text-xs font-semibold">
            {t("codingagentsettingssection.PowerfulModel")}
          </span>
          <select
            className="px-2.5 py-1.5 border border-border bg-card text-xs focus:border-accent focus:outline-none shadow-sm rounded-lg"
            value={powerfulValue}
            onChange={(event) =>
              setPref(`${prefix}_MODEL_POWERFUL`, event.target.value)
            }
          >
            <option value="">{t("codingagentsettingssection.Default")}</option>
            {modelOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 flex flex-col gap-1.5">
          <span className="text-xs font-semibold">
            {t("codingagentsettingssection.FastModel")}
          </span>
          <select
            className="px-2.5 py-1.5 border border-border bg-card text-xs focus:border-accent focus:outline-none shadow-sm rounded-lg"
            value={fastValue}
            onChange={(event) =>
              setPref(`${prefix}_MODEL_FAST`, event.target.value)
            }
          >
            <option value="">{t("codingagentsettingssection.Default")}</option>
            {modelOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="text-[11px] text-[var(--muted)] mt-1.5">
        {isDynamic
          ? t("codingagentsettingssection.ModelsFetched")
          : t("codingagentsettingssection.UsingFallback")}
      </div>

      <ConfigSaveFooter
        dirty={dirty}
        saving={saving}
        saveError={saveError}
        saveSuccess={saveSuccess}
        onSave={() => void handleSave()}
      />
    </div>
  );
}
