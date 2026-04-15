

import { useCallback, useEffect, useState } from "react";
import {
  type AudioGenProvider,
  client,
  type ImageProvider,
  type MediaConfig,
  type MediaMode,
  type VideoProvider,
  type VisionProvider,
} from "../../api";
import { useTimeout } from "@elizaos/ui";
import { COMPANION_ENABLED } from "../../navigation";
import { useApp } from "../../state";
import {
  CloudConnectionStatus,
  CloudSourceModeToggle,
} from "../cloud/CloudSourceControls";
import { MusicPlayerSettingsPanel } from "./MusicPlayerSettingsPanel";
import { ProviderModelSelectors } from "./media-settings-providers";
import {
  CATEGORY_LABELS,
  COMPANION_HALF_FRAMERATE_OPTIONS,
  COMPANION_VRM_POWER_OPTIONS,
  getApiKeyField,
  getNestedValue,
  getProvidersForCategory,
  MEDIA_API_SOURCE_CATEGORY_KEYS,
  type MediaCategory,
  setNestedValue,
} from "./media-settings-types";
import { VoiceConfigView } from "./VoiceConfigView";
import { Button, SaveFooter, SettingsControls, Switch } from "@elizaos/ui";

// ── Re-exports (public API) ──────────────────────────────────────────

export { DesktopMediaControlPanel } from "./media-settings-providers";
export { DESKTOP_MEDIA_CLICK_AUDIT } from "./media-settings-types";

// ── Main component ───────────────────────────────────────────────────

export function MediaSettingsSection() {
  const { setTimeout } = useTimeout();

  const {
    t,
    elizaCloudConnected,
    companionVrmPowerMode,
    setCompanionVrmPowerMode,
    companionAnimateWhenHidden,
    setCompanionAnimateWhenHidden,
    companionHalfFramerateMode,
    setCompanionHalfFramerateMode,
  } = useApp();
  const [mediaConfig, setMediaConfig] = useState<MediaConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MediaCategory>("image");
  const [dirty, setDirty] = useState(false);

  // Load config on mount
  useEffect(() => {
    void (async () => {
      setLoading(true);
      const cfg = await client.getConfig();
      setMediaConfig((cfg.media as MediaConfig) ?? {});
      setLoading(false);
    })();
  }, []);

  // Get current category config
  const getCategoryConfig = useCallback(
    (category: MediaCategory) => {
      return ((mediaConfig as Record<string, unknown>)[category] ??
        {}) as Record<string, unknown>;
    },
    [mediaConfig],
  );

  // Get mode for category
  const getMode = useCallback(
    (category: MediaCategory): MediaMode => {
      const cfg = getCategoryConfig(category);
      return (cfg.mode as MediaMode) ?? "cloud";
    },
    [getCategoryConfig],
  );

  // Get provider for category
  const getProvider = useCallback(
    (category: MediaCategory): string => {
      const cfg = getCategoryConfig(category);
      return (cfg.provider as string) ?? "cloud";
    },
    [getCategoryConfig],
  );

  // Update category config
  const updateCategoryConfig = useCallback(
    (category: MediaCategory, updates: Record<string, unknown>) => {
      setMediaConfig((prev) => ({
        ...prev,
        [category]: {
          ...(((prev as Record<string, unknown>)[category] as Record<
            string,
            unknown
          >) ?? {}),
          ...updates,
        },
      }));
      setDirty(true);
    },
    [],
  );

  // Update nested value in config
  const updateNestedValue = useCallback((path: string, value: unknown) => {
    setMediaConfig(
      (prev) =>
        setNestedValue(
          prev as Record<string, unknown>,
          path,
          value,
        ) as MediaConfig,
    );
    setDirty(true);
  }, []);

  // Save handler
  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      await client.updateConfig({ media: mediaConfig });
      setSaveSuccess(true);
      setDirty(false);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? "Save failed");
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [mediaConfig, setTimeout]);

  // Check if provider is configured
  const isProviderConfigured = useCallback(
    (category: MediaCategory): boolean => {
      if (category === "voice") return true;
      const mode = getMode(category);
      if (mode === "cloud") return elizaCloudConnected;

      const provider = getProvider(category);
      const apiKeyField = getApiKeyField(category, provider);
      if (!apiKeyField) return true;

      const value = getNestedValue(
        mediaConfig as Record<string, unknown>,
        apiKeyField.path,
      );
      return typeof value === "string" && value.length > 0;
    },
    [getMode, getProvider, mediaConfig, elizaCloudConnected],
  );

  if (loading) {
    return (
      <div className="py-8 text-center text-muted text-xs">
        {t("mediasettingssection.LoadingMediaConfig")}
      </div>
    );
  }

  const isVoiceTab = activeTab === "voice";
  const currentMode = isVoiceTab ? ("cloud" as MediaMode) : getMode(activeTab);
  const currentProvider = isVoiceTab ? "cloud" : getProvider(activeTab);
  const providers = isVoiceTab ? [] : getProvidersForCategory(activeTab);
  const apiKeyField = isVoiceTab
    ? null
    : getApiKeyField(activeTab, currentProvider);
  const configured = isProviderConfigured(activeTab);

  return (
    <div className="flex flex-col gap-4">
      <MusicPlayerSettingsPanel />

      {COMPANION_ENABLED && (
        <div
          className="rounded-xl border border-border bg-card/60 px-3 py-3 flex flex-col gap-3"
          data-testid="settings-companion-vrm-power"
        >
          <div className="min-w-0">
            <div className="text-xs font-semibold text-txt">
              {t("settings.companionVrmPower.label")}
            </div>
            <div className="text-2xs text-muted mt-1 leading-snug">
              {t("settings.companionVrmPower.desc")}
            </div>
          </div>
          <SettingsControls.SegmentedGroup>
            {COMPANION_VRM_POWER_OPTIONS.map((mode) => {
              const active = companionVrmPowerMode === mode;
              return (
                <Button
                  key={mode}
                  type="button"
                  variant={active ? "default" : "ghost"}
                  size="sm"
                  className={`flex-1 basis-[calc(50%-0.125rem)] sm:basis-0 min-h-touch rounded-lg border px-2 py-1.5 text-xs-tight font-semibold !whitespace-normal ${
                    active
                      ? "border-accent/45 bg-accent/16 text-txt-strong shadow-sm"
                      : "border-border/40 text-muted-strong hover:border-border-strong hover:bg-bg-hover hover:text-txt"
                  }`}
                  onClick={() => setCompanionVrmPowerMode(mode)}
                  aria-pressed={active}
                >
                  {t(`settings.companionVrmPower.${mode}`)}
                </Button>
              );
            })}
          </SettingsControls.SegmentedGroup>
          <div
            className="flex flex-col gap-2 pt-3"
            data-testid="settings-companion-half-framerate"
          >
            <div className="min-w-0">
              <div className="text-xs font-semibold text-txt">
                {t("settings.companionHalfFramerate.label")}
              </div>
              <div className="text-2xs text-muted mt-1 leading-snug">
                {t("settings.companionHalfFramerate.desc")}
              </div>
            </div>
            <SettingsControls.SegmentedGroup>
              {COMPANION_HALF_FRAMERATE_OPTIONS.map((mode) => {
                const active = companionHalfFramerateMode === mode;
                return (
                  <Button
                    key={mode}
                    type="button"
                    variant={active ? "default" : "ghost"}
                    size="sm"
                    className={`flex-1 basis-[calc(50%-0.125rem)] sm:basis-0 min-h-touch rounded-lg border px-2 py-1.5 text-xs-tight font-semibold !whitespace-normal ${
                      active
                        ? "border-accent/45 bg-accent/16 text-txt-strong shadow-sm"
                        : "border-border/40 text-muted-strong hover:border-border-strong hover:bg-bg-hover hover:text-txt"
                    }`}
                    onClick={() => setCompanionHalfFramerateMode(mode)}
                    aria-pressed={active}
                  >
                    {t(`settings.companionHalfFramerate.${mode}`)}
                  </Button>
                );
              })}
            </SettingsControls.SegmentedGroup>
          </div>
          <div
            className="flex flex-col gap-2 pt-3"
            data-testid="settings-companion-animate-when-hidden"
          >
            <div className="text-xs font-semibold text-txt">
              {t("settings.companionAnimateWhenHidden.title")}
            </div>
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0 flex-1 text-2xs text-muted leading-snug pr-2">
                {t("settings.companionAnimateWhenHidden.desc")}
              </div>
              <Switch
                className="shrink-0"
                checked={companionAnimateWhenHidden}
                onCheckedChange={(v: boolean) => setCompanionAnimateWhenHidden(v)}
                aria-label={t("settings.companionAnimateWhenHidden.title")}
              />
            </div>
          </div>
        </div>
      )}

      {/* biome-ignore lint/a11y/useSemanticElements: existing pattern */}
      <div
        className="flex flex-col gap-4 rounded-xl border border-border/70 bg-card/85 px-3 py-3 shadow-sm"
        data-testid="settings-media-generate-group"
        role="region"
        aria-label={t("mediasettingssection.GenerateGroupRegionLabel", {
          defaultValue: "Media generation by category",
        })}
      >
        <header className="flex flex-col gap-0.5 pb-2">
          <p className="text-2xs font-bold uppercase tracking-[0.1em] text-muted">
            {t("mediasettingssection.GenerateGroupTitle", {
              defaultValue: "Generation",
            })}
          </p>
          <p className="text-2xs text-muted leading-snug">
            {t("mediasettingssection.GenerateGroupHint", {
              defaultValue:
                "Use the tabs to switch category; settings below apply to the selected tab.",
            })}
          </p>
        </header>

        {/* Category tabs */}
        <SettingsControls.SegmentedGroup>
          {(
            ["image", "video", "audio", "vision", "voice"] as MediaCategory[]
          ).map((cat) => {
            const active = activeTab === cat;
            const catConfigured = isProviderConfigured(cat);
            return (
              <Button
                key={cat}
                variant={active ? "default" : "ghost"}
                size="sm"
                className={`flex-1 basis-[calc(50%-0.125rem)] sm:basis-0 min-h-touch rounded-lg border px-2 py-2 text-2xs sm:text-xs font-semibold !whitespace-normal ${
                  active
                    ? "border-accent/45 bg-accent/16 text-txt-strong shadow-sm"
                    : "border-border/40 text-muted-strong hover:border-border-strong hover:bg-bg-hover hover:text-txt"
                }`}
                onClick={() => setActiveTab(cat)}
              >
                <span>{t(CATEGORY_LABELS[cat])}</span>
                <span
                  className={`ml-1.5 inline-block w-1.5 h-1.5 rounded-full ${
                    catConfigured ? "bg-ok" : "bg-border-strong"
                  }`}
                />
              </Button>
            );
          })}
        </SettingsControls.SegmentedGroup>

        {/* Voice tab — render VoiceConfigView instead of media config */}
        {activeTab === "voice" ? (
          <VoiceConfigView />
        ) : (
          <>
            {/* Mode toggle (cloud vs own-key) */}
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <span className="text-xs font-semibold text-muted w-full sm:w-auto">
                {t("mediasettingssection.APISourceForCategory", {
                  category: t(
                    MEDIA_API_SOURCE_CATEGORY_KEYS[
                      activeTab as keyof typeof MEDIA_API_SOURCE_CATEGORY_KEYS
                    ],
                  ),
                })}
              </span>
              <CloudSourceModeToggle
                mode={currentMode}
                onChange={(mode) => {
                  if (mode === "cloud") {
                    updateCategoryConfig(activeTab, {
                      mode: "cloud",
                      provider: "cloud",
                    });
                    return;
                  }
                  updateCategoryConfig(activeTab, { mode: "own-key" });
                }}
              />

              {/* Status badge */}
              <span
                className={`ml-auto rounded-full border px-2 py-0.5 text-2xs ${
                  configured
                    ? "border-ok bg-ok/10 text-txt"
                    : "border-warn bg-warn-subtle text-txt"
                }`}
              >
                {configured
                  ? t("config-field.Configured")
                  : t("mediasettingssection.NeedsSetup")}
              </span>
            </div>

            {/* Cloud mode status */}
            {currentMode === "cloud" && (
              <CloudConnectionStatus
                connected={elizaCloudConnected}
                disconnectedText={t(
                  "elizaclouddashboard.ElizaCloudNotConnectedSettings",
                )}
              />
            )}

            {/* Own-key mode: provider selection */}
            {currentMode === "own-key" && (
              <div className="flex flex-col gap-3">
                <div className="text-xs font-semibold text-muted">
                  {t("mediasettingssection.Provider")}
                </div>
                <div
                  className="grid gap-1.5"
                  style={{
                    gridTemplateColumns: `repeat(${providers.length}, 1fr)`,
                  }}
                >
                  {providers
                    .filter((p) => p.id !== "cloud")
                    .map((p) => {
                      const active = currentProvider === p.id;
                      return (
                        <Button
                          key={p.id}
                          variant="outline"
                          size="sm"
                          className={`h-auto px-3 py-2 text-xs font-normal rounded-lg border border-border ${
                            active
                              ? "bg-accent/10 border-accent text-txt"
                              : "bg-card text-txt hover:bg-bg-hover"
                          }`}
                          onClick={() =>
                            updateCategoryConfig(activeTab, {
                              provider: p.id as
                                | ImageProvider
                                | VideoProvider
                                | AudioGenProvider
                                | VisionProvider,
                            })
                          }
                        >
                          <div className="font-semibold">
                            {p.id === "cloud"
                              ? t("providerswitcher.elizaCloud")
                              : t(p.labelKey)}
                          </div>
                          <div className="text-2xs text-muted mt-0.5">
                            {p.id === "cloud"
                              ? t("elizaclouddashboard.NoSetupNeeded")
                              : t(p.hint)}
                          </div>
                        </Button>
                      );
                    })}
                </div>

                {/* API Key input */}
                {apiKeyField && (
                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-semibold">
                      {t(apiKeyField.labelKey)}
                    </span>
                    <SettingsControls.Input
                      type="password"
                      variant="compact"
                      placeholder={
                        getNestedValue(
                          mediaConfig as Record<string, unknown>,
                          apiKeyField.path,
                        )
                          ? t("mediasettingssection.ApiKeySetLeaveBlank")
                          : t("mediasettingssection.EnterApiKey")
                      }
                      onChange={(e) =>
                        updateNestedValue(
                          apiKeyField.path,
                          e.target.value || undefined,
                        )
                      }
                    />
                  </div>
                )}

                <ProviderModelSelectors
                  activeTab={activeTab}
                  currentProvider={currentProvider}
                  mediaConfig={mediaConfig}
                  updateNestedValue={updateNestedValue}
                  t={t}
                />
              </div>
            )}

            <SaveFooter
              dirty={dirty}
              saving={saving}
              saveError={saveError}
              saveSuccess={saveSuccess}
              onSave={() => void handleSave()}
            />
          </>
        )}
      </div>
    </div>
  );
}
