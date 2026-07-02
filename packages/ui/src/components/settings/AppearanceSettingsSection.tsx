import type { LucideIcon } from "lucide-react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useAgentElement } from "../../agent-surface";
import { cn } from "../../lib/utils";
import { useAppSelector, useContentPack } from "../../state";
import type { UiThemeMode } from "../../state/ui-preferences";
import { LANGUAGES } from "../shared/LanguageDropdown.helpers";
import { Switch } from "../ui/switch";
import { AdvancedToggle } from "./AdvancedToggle";
import { useAdvancedSettingsEnabled } from "./AdvancedToggle.hooks";
import { selectableTileClass } from "./appearance-primitives.helpers";
import { LoadContentPackForm } from "./LoadContentPackForm";
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
    <button
      ref={ref}
      type="button"
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
    </button>
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
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      aria-current={isActive ? "true" : undefined}
      className={cn(
        "flex min-h-10 flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors",
        isActive
          ? "bg-accent/12 text-accent  "
          : "text-muted hover:bg-surface hover:text-txt",
      )}
      {...agentProps}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      {label}
    </button>
  );
}

export function AppearanceSettingsSection() {
  const setUiLanguage = useAppSelector((s) => s.setUiLanguage);
  const uiLanguage = useAppSelector((s) => s.uiLanguage);
  const uiThemeMode = useAppSelector((s) => s.uiThemeMode);
  const setUiThemeMode = useAppSelector((s) => s.setUiThemeMode);
  const homeTimeWidgetHidden = useAppSelector((s) => s.homeTimeWidgetHidden);
  const setHomeTimeWidgetHidden = useAppSelector(
    (s) => s.setHomeTimeWidgetHidden,
  );
  const t = useAppSelector((s) => s.t);
  const { activePack, loadedPacks, toggle } = useContentPack();
  const advancedEnabled = useAdvancedSettingsEnabled();

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

      <LoadedPacksList
        loadedPacks={loadedPacks}
        activePackId={activePack?.manifest.id ?? null}
        onToggle={toggle}
      />

      <SettingsGroup>
        <SettingsRow
          label={t("settings.advanced", { defaultValue: "Advanced" })}
          control={<AdvancedToggle label="Advanced" />}
        />
      </SettingsGroup>

      {advancedEnabled && <LoadContentPackForm />}
    </SettingsStack>
  );
}
