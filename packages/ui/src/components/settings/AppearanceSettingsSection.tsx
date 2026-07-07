/**
 * Settings → Appearance section: theme mode, brand accent preset, UI language,
 * the home time/date widget toggle, the background/wallpaper picker, and loaded
 * content packs. All choices persist through the app store (`useAppSelector`
 * setters); every tile is agent-addressable via `useAgentElement`. Background
 * lives here (not a separate tab) since it is one appearance choice; the
 * standalone Background settings section is consolidated into this one.
 */

import type { LucideIcon } from "lucide-react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useAgentElement } from "../../agent-surface";
import { cn } from "../../lib/utils";
import { ACCENT_PRESETS, useAppSelector, useContentPack } from "../../state";
import type { AccentPreset, UiThemeMode } from "../../state/ui-preferences";
import { LANGUAGES } from "../shared/LanguageDropdown.helpers";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { selectableTileClass } from "./appearance-primitives.helpers";
import { BackgroundSettingsControls } from "./BackgroundSettingsControls";
import { LoadedPacksList } from "./LoadedPacksList";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

function LanguageTileButton({
  languageId,
  label,
  flag,
  isActive,
  onSelect,
}: {
  languageId: string;
  label: string;
  flag: string;
  isActive: boolean;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `appearance-language-${languageId}`,
    role: "tab",
    label,
    group: "appearance-language",
    status: isActive ? "active" : "inactive",
    onActivate: onSelect,
  });
  return (
    <Button
      ref={ref}
      variant="ghost"
      onClick={onSelect}
      aria-current={isActive ? "true" : undefined}
      className={selectableTileClass(isActive)}
      {...agentProps}
    >
      <div className="flex items-center gap-2">
        <span className="text-base leading-none">{flag}</span>
        <span className="text-xs font-medium text-txt">{label}</span>
      </div>
      {isActive ? (
        <Check className="absolute right-1.5 top-1.5 h-3 w-3 text-accent" />
      ) : null}
    </Button>
  );
}

const THEME_OPTIONS: { mode: UiThemeMode; label: string; icon: LucideIcon }[] =
  [
    { mode: "light", label: "Light", icon: Sun },
    { mode: "dark", label: "Dark", icon: Moon },
    { mode: "system", label: "System", icon: Monitor },
  ];

function ThemeTileButton({
  mode,
  label,
  icon: Icon,
  isActive,
  onSelect,
}: {
  mode: UiThemeMode;
  label: string;
  icon: LucideIcon;
  isActive: boolean;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `appearance-theme-${mode}`,
    role: "tab",
    label,
    group: "appearance-theme",
    status: isActive ? "active" : "inactive",
    onActivate: onSelect,
  });
  return (
    <Button
      ref={ref}
      variant="ghost"
      onClick={onSelect}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "min-h-10 flex-1 gap-2 whitespace-normal rounded-md px-3 text-sm font-medium transition-colors",
        isActive
          ? "bg-accent/12 text-accent  "
          : "text-muted hover:bg-surface hover:text-txt",
      )}
      {...agentProps}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      {label}
    </Button>
  );
}

function AccentTileButton({
  preset,
  isActive,
  onSelect,
}: {
  preset: AccentPreset;
  isActive: boolean;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `appearance-accent-${preset.id}`,
    role: "tab",
    label: preset.label,
    group: "appearance-accent",
    status: isActive ? "active" : "inactive",
    onActivate: onSelect,
  });
  // The `default` preset carries no color (brand accent) — render the live
  // `--accent` token so its swatch tracks the brand accent.
  const swatchColor = preset.color ?? "var(--accent)";
  return (
    <Button
      ref={ref}
      variant="ghost"
      onClick={onSelect}
      aria-current={isActive ? "true" : undefined}
      className={selectableTileClass(isActive)}
      {...agentProps}
    >
      <span
        aria-hidden
        className="h-5 w-5 rounded-full border border-border/40"
        style={{ backgroundColor: swatchColor }}
      />
      <span className="text-xs font-medium text-txt">{preset.label}</span>
      {isActive ? (
        <Check className="absolute right-1.5 top-1.5 h-3 w-3 text-accent" />
      ) : null}
    </Button>
  );
}

export function AppearanceSettingsSection() {
  const setUiLanguage = useAppSelector((s) => s.setUiLanguage);
  const uiLanguage = useAppSelector((s) => s.uiLanguage);
  const uiThemeMode = useAppSelector((s) => s.uiThemeMode);
  const setUiThemeMode = useAppSelector((s) => s.setUiThemeMode);
  const uiAccentId = useAppSelector((s) => s.uiAccentId);
  const setUiAccent = useAppSelector((s) => s.setUiAccent);
  const homeTimeWidgetHidden = useAppSelector((s) => s.homeTimeWidgetHidden);
  const setHomeTimeWidgetHidden = useAppSelector(
    (s) => s.setHomeTimeWidgetHidden,
  );
  const t = useAppSelector((s) => s.t);
  const { activePack, loadedPacks, toggle } = useContentPack();

  return (
    <SettingsStack>
      <SettingsGroup
        bare
        title={t("settings.theme", { defaultValue: "Theme" })}
      >
        <div className="flex gap-2">
          {THEME_OPTIONS.map((option) => (
            <ThemeTileButton
              key={option.mode}
              mode={option.mode}
              label={t(`settings.theme.${option.mode}`, {
                defaultValue: option.label,
              })}
              icon={option.icon}
              isActive={uiThemeMode === option.mode}
              onSelect={() => setUiThemeMode(option.mode)}
            />
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup
        bare
        title={t("settings.accent", { defaultValue: "Accent color" })}
      >
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {ACCENT_PRESETS.map((preset) => (
            <AccentTileButton
              key={preset.id}
              preset={preset}
              isActive={uiAccentId === preset.id}
              onSelect={() => setUiAccent(preset.id)}
            />
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup
        bare
        title={t("settings.language", { defaultValue: "Language" })}
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {LANGUAGES.map((language) => (
            <LanguageTileButton
              key={language.id}
              languageId={language.id}
              label={language.label}
              flag={language.flag}
              isActive={uiLanguage === language.id}
              onSelect={() => setUiLanguage(language.id)}
            />
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup
        bare
        title={t("settings.homeDashboard", { defaultValue: "Home" })}
      >
        <SettingsRow
          label={t("settings.showTimeWidget", {
            defaultValue: "Show time & date",
          })}
          control={
            <Switch
              checked={!homeTimeWidgetHidden}
              onCheckedChange={(checked) => setHomeTimeWidgetHidden(!checked)}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        bare
        title={t("settings.sections.background.label", {
          defaultValue: "Background",
        })}
      >
        <BackgroundSettingsControls />
      </SettingsGroup>

      <LoadedPacksList
        loadedPacks={loadedPacks}
        activePackId={activePack?.manifest.id ?? null}
        onToggle={toggle}
      />
    </SettingsStack>
  );
}
