import type { ResolvedContentPack } from "@elizaos/shared";
import { Button, Input } from "@elizaos/ui";
import { Check, FolderOpen, Moon, Sun } from "lucide-react";
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
import { LANGUAGES } from "../shared/LanguageDropdown";

function supportsDirectoryUpload(): boolean {
  if (typeof document === "undefined") return false;
  const input = document.createElement("input") as HTMLInputElement & {
    webkitdirectory?: string | boolean;
  };
  return "webkitdirectory" in input;
}

function isSafeContentPackUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
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
    setUiLanguage,
    uiTheme,
    uiLanguage,
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
    if (!persistedUrl || !isSafeContentPackUrl(persistedUrl)) {
      if (persistedUrl) savePersistedActivePackUrl(null);
      return;
    }

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
    if (!isSafeContentPackUrl(url)) {
      setPackLoadError("Pack URL must be an http(s) URL");
      return;
    }

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
      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          {t("settings.language", { defaultValue: "Language" })}
        </h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {LANGUAGES.map((language) => {
            const isActive = uiLanguage === language.id;

            return (
              <button
                key={language.id}
                type="button"
                onClick={() => setUiLanguage(language.id)}
                className={selectableTileClass(isActive)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-base leading-none">
                    {language.flag}
                  </span>
                  <span className="text-xs font-medium text-txt">
                    {language.label}
                  </span>
                </div>
                {isActive ? (
                  <Check className="absolute right-1.5 top-1.5 h-3 w-3 text-accent" />
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          {t("settings.appearance.mode", { defaultValue: "Mode" })}
        </h3>
        <div className="flex gap-2">
          <ModeButton
            active={!isDark}
            icon={<Sun className="h-4 w-4" />}
            label={t("settings.appearance.light", { defaultValue: "Light" })}
            onClick={() => setUiTheme("light")}
          />
          <ModeButton
            active={isDark}
            icon={<Moon className="h-4 w-4" />}
            label={t("settings.appearance.dark", { defaultValue: "Dark" })}
            onClick={() => setUiTheme("dark")}
          />
        </div>
      </section>

      {loadedPacks.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
            {t("settings.appearance.loadedPacks", {
              defaultValue: "Loaded content packs",
            })}
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {loadedPacks.map((pack) => {
              const isActive = activePackId === pack.manifest.id;
              return (
                <button
                  key={pack.manifest.id}
                  type="button"
                  onClick={() => handleTogglePack(pack)}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                    isActive
                      ? "border-accent bg-accent/8"
                      : "border-border/50 hover:border-accent/40 hover:bg-bg-hover"
                  }`}
                >
                  {pack.vrmPreviewUrl && (
                    <img
                      src={pack.vrmPreviewUrl}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-txt">
                      {pack.manifest.name}
                    </p>
                    {pack.manifest.description && (
                      <p className="truncate text-xs-tight text-muted">
                        {pack.manifest.description}
                      </p>
                    )}
                  </div>
                  {isActive && (
                    <span
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/10 text-accent"
                      title={t("settings.appearance.active", {
                        defaultValue: "Active",
                      })}
                      role="img"
                      aria-label={t("settings.appearance.active", {
                        defaultValue: "Active",
                      })}
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          {t("startupshell.LoadPack", {
            defaultValue: "Load content pack",
          })}
        </h3>
        <div className="flex items-center gap-2">
          <Input
            placeholder={t("settings.appearance.packUrlPlaceholder", {
              defaultValue: "https://example.com/packs/my-pack/",
            })}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="h-9 flex-1 rounded-lg bg-bg text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleLoadFromUrl();
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-9 rounded-lg"
            onClick={handleLoadFromUrl}
            disabled={!urlInput.trim()}
          >
            {t("settings.appearance.load", { defaultValue: "Load" })}
          </Button>
          {canPickDirectory && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 rounded-lg text-xs text-muted hover:text-txt"
                onClick={() => fileInputRef.current?.click()}
                title={t("settings.appearance.loadFromFolder", {
                  defaultValue: "From folder",
                })}
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                {t("settings.appearance.loadFromFolder", {
                  defaultValue: "From folder",
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
          <p className="text-xs-tight text-destructive">{packLoadError}</p>
        )}
        {activePackId && (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs-tight text-muted hover:text-txt"
            onClick={deactivatePack}
          >
            {t("settings.appearance.deactivate", {
              defaultValue: "Deactivate current pack",
            })}
          </Button>
        )}
      </section>
    </div>
  );
}

function selectableTileClass(active: boolean): string {
  return `relative flex min-h-11 flex-col items-center justify-center gap-1.5 rounded-lg border p-3 transition-colors ${
    active
      ? "border-accent bg-accent/8"
      : "border-border/50 hover:border-accent/40 hover:bg-bg-hover"
  }`;
}

function ModeButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-10 w-10 items-center justify-center rounded-lg border text-sm font-medium transition-colors ${
        active
          ? "border-accent bg-accent/8 text-txt"
          : "border-border/50 text-muted hover:border-accent/40 hover:bg-bg-hover hover:text-txt"
      }`}
    >
      {icon}
    </button>
  );
}
