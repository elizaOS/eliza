/**
 * AppearanceSettingsSection — content pack loading, VRM selection,
 * backgrounds, and color scheme customization.
 *
 * Migrated from the splash screen to Settings so packs can be managed
 * at any time, not just during onboarding.
 */

import type { ResolvedContentPack } from "@elizaos/shared/contracts/content-pack";
import { BUILTIN_THEMES } from "@elizaos/shared/themes/presets";
import { Button, Card, CardContent, Input } from "@elizaos/ui";
import { Check, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyColorScheme,
  applyContentPack,
  loadContentPackFromFiles,
  loadContentPackFromUrl,
  releaseLoadedContentPack,
} from "../../content-packs";
import {
  loadPersistedActivePackUrl,
  savePersistedActivePackUrl,
  useApp,
} from "../../state";

function supportsDirectoryUpload(): boolean {
  if (typeof document === "undefined") return false;
  const input = document.createElement("input") as HTMLInputElement & {
    webkitdirectory?: string | boolean;
  };
  return "webkitdirectory" in input;
}

export function AppearanceSettingsSection() {
  const {
    setState,
    activePackId,
    selectedVrmIndex,
    customVrmUrl,
    customVrmPreviewUrl,
    customBackgroundUrl,
    customWorldUrl,
    onboardingName,
    onboardingStyle,
    themeId,
    setThemeId,
    uiTheme,
    setUiTheme,
    t,
  } = useApp();

  const [loadedPacks, setLoadedPacks] = useState<ResolvedContentPack[]>([]);
  const [packLoadError, setPackLoadError] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const colorSchemeCleanupRef = useRef<(() => void) | null>(null);
  const loadedPacksRef = useRef<ResolvedContentPack[]>([]);
  const baselineRef = useRef<{
    selectedVrmIndex: number;
    customVrmUrl: string;
    customVrmPreviewUrl: string;
    customBackgroundUrl: string;
    customWorldUrl: string;
    onboardingName: string;
    onboardingStyle: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rehydratedRef = useRef(false);
  const canPickDirectory = useMemo(() => supportsDirectoryUpload(), []);

  // Keep ref in sync for cleanup
  useEffect(() => {
    loadedPacksRef.current = loadedPacks;
  }, [loadedPacks]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const pack of loadedPacksRef.current) {
        releaseLoadedContentPack(pack);
      }
    };
  }, []);

  // Set directory attributes on file input
  useEffect(() => {
    if (!canPickDirectory || !fileInputRef.current) return;
    fileInputRef.current.setAttribute("webkitdirectory", "");
    fileInputRef.current.setAttribute("directory", "");
  }, [canPickDirectory]);

  // Rehydrate persisted pack on first mount
  useEffect(() => {
    if (rehydratedRef.current) return;
    rehydratedRef.current = true;

    if (!activePackId) return;

    const persistedUrl = loadPersistedActivePackUrl();
    if (!persistedUrl) return;

    let cancelled = false;
    void loadContentPackFromUrl(persistedUrl)
      .then((pack) => {
        if (cancelled) return;
        setLoadedPacks((prev) => {
          if (prev.some((p) => p.manifest.id === pack.manifest.id)) return prev;
          return [...prev, pack];
        });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(
          "[eliza][content-packs] Failed to restore persisted pack:",
          err,
        );
        savePersistedActivePackUrl(null);
        setState("activePackId", null);
      });

    return () => {
      cancelled = true;
    };
  }, [activePackId, setState]);

  const activatePack = useCallback(
    (pack: ResolvedContentPack) => {
      if (baselineRef.current == null) {
        baselineRef.current = {
          selectedVrmIndex,
          customVrmUrl,
          customVrmPreviewUrl,
          customBackgroundUrl,
          customWorldUrl,
          onboardingName,
          onboardingStyle,
        };
      }

      setState("activePackId", pack.manifest.id);
      savePersistedActivePackUrl(
        pack.source.kind === "url" ? pack.source.url : null,
      );
      applyContentPack(pack, {
        setCustomVrmUrl: (url) => setState("customVrmUrl", url),
        setCustomVrmPreviewUrl: (url) => setState("customVrmPreviewUrl", url),
        setCustomBackgroundUrl: (url) => setState("customBackgroundUrl", url),
        setCustomWorldUrl: (url) => setState("customWorldUrl", url),
        setSelectedVrmIndex: (idx) => setState("selectedVrmIndex", idx),
        setOnboardingName: (name) => setState("onboardingName", name),
        setOnboardingStyle: (style) => setState("onboardingStyle", style),
        setCustomCatchphrase: (phrase) => setState("customCatchphrase", phrase),
        setCustomVoicePresetId: (id) => setState("customVoicePresetId", id),
      });
      colorSchemeCleanupRef.current?.();
      colorSchemeCleanupRef.current = applyColorScheme(pack.colorScheme);
      setPackLoadError(null);
    },
    [
      customBackgroundUrl,
      customVrmUrl,
      customVrmPreviewUrl,
      customWorldUrl,
      onboardingName,
      onboardingStyle,
      selectedVrmIndex,
      setState,
    ],
  );

  const deactivatePack = useCallback(() => {
    const activePack = activePackId
      ? loadedPacksRef.current.find((p) => p.manifest.id === activePackId)
      : null;

    if (activePack?.source.kind === "file") {
      releaseLoadedContentPack(activePack);
      setLoadedPacks((prev) =>
        prev.filter((p) => p.manifest.id !== activePack.manifest.id),
      );
    }

    setState("activePackId", null);
    savePersistedActivePackUrl(null);
    colorSchemeCleanupRef.current?.();
    colorSchemeCleanupRef.current = null;

    // Restore baseline
    const baseline = baselineRef.current;
    if (baseline) {
      setState("selectedVrmIndex", baseline.selectedVrmIndex);
      setState("customVrmUrl", baseline.customVrmUrl);
      setState("customVrmPreviewUrl", baseline.customVrmPreviewUrl);
      setState("customBackgroundUrl", baseline.customBackgroundUrl);
      setState("customWorldUrl", baseline.customWorldUrl);
      setState("onboardingName", baseline.onboardingName);
      setState("onboardingStyle", baseline.onboardingStyle);
      baselineRef.current = null;
    }
    setPackLoadError(null);
  }, [activePackId, setState]);

  const handleTogglePack = useCallback(
    (pack: ResolvedContentPack) => {
      if (activePackId === pack.manifest.id) {
        deactivatePack();
      } else {
        activatePack(pack);
      }
    },
    [activePackId, activatePack, deactivatePack],
  );

  const handleLoadFromUrl = useCallback(async () => {
    const url = urlInput.trim();
    if (!url) return;

    try {
      const pack = await loadContentPackFromUrl(url);
      setLoadedPacks((prev) => {
        if (prev.some((p) => p.manifest.id === pack.manifest.id)) return prev;
        return [...prev, pack];
      });
      activatePack(pack);
      setUrlInput("");
    } catch (err) {
      setPackLoadError(
        `Failed to load pack: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }
  }, [urlInput, activatePack]);

  const handleFolderSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length === 0) return;

      try {
        const pack = await loadContentPackFromFiles(files);
        setLoadedPacks((prev) => {
          if (prev.some((p) => p.manifest.id === pack.manifest.id)) {
            releaseLoadedContentPack(pack);
            return prev;
          }
          return [...prev, pack];
        });
        activatePack(pack);
      } catch (err) {
        setPackLoadError(
          `Failed to load pack: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }

      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [activatePack],
  );

  const isDark = uiTheme === "dark";

  return (
    <div className="space-y-6">
      {/* Light / Dark mode */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-txt/70">
          {t("settings.appearance.mode", { defaultValue: "Mode" })}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setUiTheme("light")}
            className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
              !isDark
                ? "border-accent bg-accent/8 ring-1 ring-accent/30"
                : "border-border hover:border-accent/40 hover:bg-bg-hover"
            }`}
          >
            <Sun className="h-4 w-4" />
            {t("settings.appearance.light", { defaultValue: "Light" })}
          </button>
          <button
            type="button"
            onClick={() => setUiTheme("dark")}
            className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
              isDark
                ? "border-accent bg-accent/8 ring-1 ring-accent/30"
                : "border-border hover:border-accent/40 hover:bg-bg-hover"
            }`}
          >
            <Moon className="h-4 w-4" />
            {t("settings.appearance.dark", { defaultValue: "Dark" })}
          </button>
        </div>
      </div>

      {/* Theme picker */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-txt/70">
          {t("settings.appearance.theme", { defaultValue: "Theme" })}
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {BUILTIN_THEMES.map((theme) => {
            const isActive = themeId === theme.id;
            const colors = isDark ? theme.dark : theme.light;
            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => setThemeId(theme.id)}
                className={`relative flex flex-col items-center gap-1.5 rounded-lg border p-3 transition-colors ${
                  isActive
                    ? "border-accent bg-accent/8 ring-1 ring-accent/30"
                    : "border-border hover:border-accent/40 hover:bg-bg-hover"
                }`}
              >
                {/* Color swatch preview */}
                <div className="flex items-center gap-1">
                  <span
                    className="h-5 w-5 rounded-full border border-border/40"
                    style={{ background: colors.bg }}
                  />
                  <span
                    className="h-5 w-5 rounded-full border border-border/40"
                    style={{ background: colors.card }}
                  />
                  <span
                    className="h-5 w-5 rounded-full border border-border/40"
                    style={{ background: colors.accent }}
                  />
                  <span
                    className="h-5 w-5 rounded-full border border-border/40"
                    style={{ background: colors.text }}
                  />
                </div>
                <span className="text-xs font-medium text-txt">
                  {theme.name}
                </span>
                {isActive && (
                  <span className="absolute right-1.5 top-1.5 rounded-full bg-accent p-0.5">
                    <Check className="h-3 w-3 text-accent-fg" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {BUILTIN_THEMES.find((t) => t.id === themeId)?.description && (
          <p className="text-xs text-muted">
            {BUILTIN_THEMES.find((t) => t.id === themeId)?.description}
          </p>
        )}
      </div>

      {/* Loaded packs */}
      {loadedPacks.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground/70">
            {t("settings.appearance.loadedPacks", {
              defaultValue: "Loaded content packs",
            })}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {loadedPacks.map((pack) => {
              const isActive = activePackId === pack.manifest.id;
              return (
                <Card
                  key={pack.manifest.id}
                  className={`cursor-pointer border transition-colors ${
                    isActive
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  }`}
                  onClick={() => handleTogglePack(pack)}
                >
                  <CardContent className="flex items-center gap-3 px-3 py-2.5">
                    {pack.vrmPreviewUrl && (
                      <img
                        src={pack.vrmPreviewUrl}
                        alt=""
                        className="h-10 w-10 rounded object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">
                        {pack.manifest.name}
                      </p>
                      {pack.manifest.description && (
                        <p className="truncate text-xs text-muted-foreground">
                          {pack.manifest.description}
                        </p>
                      )}
                    </div>
                    {isActive && (
                      <span className="shrink-0 rounded bg-primary px-2 py-0.5 text-2xs font-bold text-primary-foreground">
                        {t("settings.appearance.active", {
                          defaultValue: "ACTIVE",
                        })}
                      </span>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Load from URL */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground/70">
          {t("settings.appearance.loadPack", {
            defaultValue: "Load content pack",
          })}
        </p>
        <div className="flex items-center gap-2">
          <Input
            placeholder={t("settings.appearance.packUrlPlaceholder", {
              defaultValue: "https://example.com/packs/my-pack/",
            })}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="flex-1 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleLoadFromUrl();
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleLoadFromUrl}
            disabled={!urlInput.trim()}
          >
            {t("settings.appearance.load", { defaultValue: "Load" })}
          </Button>
        </div>

        {canPickDirectory && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              {t("settings.appearance.loadFromFolder", {
                defaultValue: "Load from folder",
              })}
            </Button>
            <input
              type="file"
              ref={fileInputRef}
              multiple
              className="hidden"
              onChange={handleFolderSelected}
            />
          </>
        )}
      </div>

      {packLoadError && (
        <p className="text-xs text-destructive">{packLoadError}</p>
      )}

      {activePackId && (
        <Button variant="ghost" size="sm" onClick={deactivatePack}>
          {t("settings.appearance.deactivate", {
            defaultValue: "Deactivate current pack",
          })}
        </Button>
      )}
    </div>
  );
}
