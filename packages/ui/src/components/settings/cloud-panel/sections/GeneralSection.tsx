/**
 * General section of the cloud-only desktop settings panel.
 *
 * Two groups: Appearance (theme, accent, language, date/time widget,
 * wallpaper) and Desktop behavior (launch on login, dock, menu bar icon,
 * tray click behavior). Appearance choices persist through the app store
 * (`useAppSelector`); the desktop toggles are local state until the
 * desktop RPC is wired.
 */
import { Check } from "lucide-react";
import * as React from "react";
import { useAgentElement } from "../../../../agent-surface";
import { cn } from "../../../../lib/utils";
import { ACCENT_PRESETS, useAppSelector } from "../../../../state";
import type { AccentPreset } from "../../../../state/ui-preferences";
import {
  BACKGROUND_CATALOG,
  CURATED_NATURAL_BACKGROUNDS,
  DEFAULT_BACKGROUND_CATALOG_ID,
} from "../../../../state/ui-preferences";
import { useBackgroundConfig } from "../../../../state/useBackgroundConfig";
import {
  SettingsGroup,
  SettingsStack,
  NuphySwitchRow,
  NuphySelectRow,
  NuphySegmentedRow,
  NuphyRow,
} from "../nuphy-settings-primitives";
import { LANGUAGES } from "../../../shared/LanguageDropdown.helpers";

const THEME_OPTIONS = [
  { value: "system", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const TRAY_CLICK_OPTIONS = [
  { value: "full-menu", label: "Full menu" },
  { value: "toggle-recording", label: "Toggle recording" },
];

/** A single accent swatch — click to select. */
function AccentSwatch({
  preset,
  isActive,
  onSelect,
}: {
  preset: AccentPreset;
  isActive: boolean;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `general-accent-${preset.id}`,
    role: "tab",
    label: preset.label,
    group: "general-accent",
    status: isActive ? "active" : "inactive",
    onActivate: onSelect,
  });
  const swatchColor = preset.color ?? "var(--accent)";
  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      aria-label={preset.label}
      aria-pressed={isActive}
      className={cn(
        "relative flex h-8 w-8 items-center justify-center rounded-full border transition-colors",
        isActive
          ? "border-accent shadow-[0_0_0_2px_var(--accent)]/30"
          : "border-hairline hover:border-accent/50",
      )}
      style={{ backgroundColor: swatchColor }}
      {...agentProps}
    >
      {isActive ? (
        <Check className="h-4 w-4 text-white drop-shadow-[0_1px_2px_var(--color-scrim)]" />
      ) : null}
    </button>
  );
}

/**
 * Resolve the current background config to a catalog id for the wallpaper
 * dropdown's selected value. Matches image configs by source URL; falls back
 * to the default catalog id.
 */
function useActiveWallpaperId(): string {
  const { backgroundConfig } = useBackgroundConfig();
  return React.useMemo(() => {
    if (backgroundConfig.mode === "image" && backgroundConfig.imageUrl) {
      const match = CURATED_NATURAL_BACKGROUNDS.find(
        (entry) => entry.source === backgroundConfig.imageUrl,
      );
      if (match) return match.id;
    }
    return DEFAULT_BACKGROUND_CATALOG_ID;
  }, [backgroundConfig]);
}

export function GeneralSection() {
  const t = useAppSelector((s) => s.t);
  const uiThemeMode = useAppSelector((s) => s.uiThemeMode);
  const setUiThemeMode = useAppSelector((s) => s.setUiThemeMode);
  const uiAccentId = useAppSelector((s) => s.uiAccentId);
  const setUiAccent = useAppSelector((s) => s.setUiAccent);
  const uiLanguage = useAppSelector((s) => s.uiLanguage);
  const setUiLanguage = useAppSelector((s) => s.setUiLanguage);
  const homeTimeWidgetHidden = useAppSelector((s) => s.homeTimeWidgetHidden);
  const setHomeTimeWidgetHidden = useAppSelector(
    (s) => s.setHomeTimeWidgetHidden,
  );
  const { setBackgroundConfig } = useBackgroundConfig();
  const activeWallpaperId = useActiveWallpaperId();

  // Desktop toggles — local state until the desktop RPC is wired.
  // TODO: replace with desktop RPC calls (launch-on-login / dock / tray).
  const [launchOnLogin, setLaunchOnLogin] = React.useState(false);
  const [showInDock, setShowInDock] = React.useState(true);
  const [menuBarIcon, setMenuBarIcon] = React.useState(true);
  const [recordOnTrayClick, setRecordOnTrayClick] = React.useState(false);
  const [trayClickAction, setTrayClickAction] = React.useState("full-menu");

  const wallpaperOptions = React.useMemo(
    () =>
      CURATED_NATURAL_BACKGROUNDS.map((entry) => ({
        value: entry.id,
        label: entry.label,
      })),
    [],
  );

  const onWallpaperChange = React.useCallback(
    (id: string) => {
      const entry = BACKGROUND_CATALOG.find((e) => e.id === id);
      if (!entry) return;
      // Reuse the catalog→config resolver path by applying the entry's
      // image source directly; image entries carry a paintable URL.
      if (entry.kind === "image") {
        setBackgroundConfig({
          mode: "image",
          color: backgroundConfigColorFallback,
          imageUrl: entry.source,
        });
      }
    },
    [setBackgroundConfig],
  );

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("settings.appearance", { defaultValue: "Appearance" })}
        footer="Choose how Eliza looks on this device."
      >
        <NuphySegmentedRow
          agentId="general-theme"
          group="general"
          label={t("settings.theme", { defaultValue: "Theme" })}
          value={uiThemeMode}
          onValueChange={(v) =>
            setUiThemeMode(v as "system" | "light" | "dark")
          }
          options={THEME_OPTIONS}
        />
        <NuphyRow
          label={t("settings.accent", { defaultValue: "Accent color" })}
        >
          <div className="flex flex-wrap items-center gap-2">
            {ACCENT_PRESETS.map((preset) => (
              <AccentSwatch
                key={preset.id}
                preset={preset}
                isActive={uiAccentId === preset.id}
                onSelect={() => setUiAccent(preset.id)}
              />
            ))}
          </div>
        </NuphyRow>
        <NuphySelectRow
          agentId="general-language"
          group="general"
          label={t("settings.language", { defaultValue: "Language" })}
          value={uiLanguage}
          onValueChange={(v) => setUiLanguage(v as typeof uiLanguage)}
          options={LANGUAGES.map((language) => ({
            value: language.id,
            label: `${language.flag} ${language.label}`,
          }))}
        />
        <NuphySwitchRow
          agentId="general-show-time-widget"
          group="general"
          label={t("settings.showTimeWidget", {
            defaultValue: "Show date & time",
          })}
          checked={!homeTimeWidgetHidden}
          onCheckedChange={(checked) => setHomeTimeWidgetHidden(!checked)}
        />
        <NuphySelectRow
          agentId="general-wallpaper"
          group="general"
          label={t("settings.sections.background.label", {
            defaultValue: "Wallpaper",
          })}
          value={activeWallpaperId}
          onValueChange={onWallpaperChange}
          options={wallpaperOptions}
        />
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.desktop", { defaultValue: "Desktop" })}
        footer="Control how Eliza integrates with macOS."
      >
        <NuphySwitchRow
          agentId="general-launch-on-login"
          group="general"
          label={t("settings.launchOnLogin", {
            defaultValue: "Launch on login",
          })}
          checked={launchOnLogin}
          onCheckedChange={setLaunchOnLogin}
        />
        <NuphySwitchRow
          agentId="general-show-in-dock"
          group="general"
          label={t("settings.showInDock", { defaultValue: "Show in Dock" })}
          checked={showInDock}
          onCheckedChange={setShowInDock}
        />
        <NuphySwitchRow
          agentId="general-menu-bar-icon"
          group="general"
          label={t("settings.menuBarIcon", { defaultValue: "Menu bar icon" })}
          checked={menuBarIcon}
          onCheckedChange={setMenuBarIcon}
        />
        <NuphySwitchRow
          agentId="general-record-on-tray-click"
          group="general"
          label={t("settings.recordOnTrayClick", {
            defaultValue: "Start recording on menu bar click",
          })}
          checked={recordOnTrayClick}
          onCheckedChange={setRecordOnTrayClick}
        />
        {recordOnTrayClick ? (
          <NuphySelectRow
            agentId="general-tray-click-action"
            group="general"
            label={t("settings.trayClickAction", {
              defaultValue: "Click to open",
            })}
            value={trayClickAction}
            onValueChange={setTrayClickAction}
            options={TRAY_CLICK_OPTIONS}
          />
        ) : null}
      </SettingsGroup>
    </SettingsStack>
  );
}

// A neutral fallback color for image-mode wallpaper configs that don't carry
// one. Kept module-local so the dropdown apply path stays self-contained.
const backgroundConfigColorFallback = "#0a0a0a";
