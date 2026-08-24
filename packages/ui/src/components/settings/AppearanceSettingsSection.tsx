/**
 * Settings → Appearance section: theme mode, brand accent preset, UI language,
 * the home time/date widget toggle, the background/wallpaper picker, and loaded
 * content packs. All choices persist through the app store (`useAppSelector`
 * setters); every tile is agent-addressable via `useAgentElement`. Background
 * lives here (not a separate tab) since it is one appearance choice; the
 * standalone Background settings section is consolidated into this one.
 */

import type { ReactNode } from "react";
import { useAgentElement } from "../../agent-surface";
import { ACCENT_PRESETS, useAppSelector, useContentPack } from "../../state";
import {
  SelectableTile,
  type SelectableTileLayout,
} from "../composites/settings";
import { LANGUAGES } from "../shared/LanguageDropdown.helpers";
import { BackgroundSettingsControls } from "./BackgroundSettingsControls";
import { LoadedPacksList } from "./LoadedPacksList";
import { SettingsSwitchRow } from "./settings-agent-rows";
import { SettingsGroup, SettingsStack } from "./settings-layout";

function AppearanceSelectableTile({
  agentId,
  group,
  label,
  leading,
  layout,
  selected,
  onSelect,
}: {
  agentId: string;
  group: string;
  label: string;
  leading: ReactNode;
  layout: SelectableTileLayout;
  selected: boolean;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "tab",
    label,
    group,
    status: selected ? "active" : "inactive",
    onActivate: onSelect,
  });
  return (
    <SelectableTile
      ref={ref}
      selected={selected}
      label={label}
      leading={leading}
      layout={layout}
      onSelect={onSelect}
      {...agentProps}
    />
  );
}

export function AppearanceSettingsSection() {
  const setUiLanguage = useAppSelector((s) => s.setUiLanguage);
  const uiLanguage = useAppSelector((s) => s.uiLanguage);
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
        title={t("settings.accent", { defaultValue: "Accent color" })}
      >
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {ACCENT_PRESETS.map((preset) => (
            <AppearanceSelectableTile
              key={preset.id}
              agentId={`appearance-accent-${preset.id}`}
              group="appearance-accent"
              label={preset.label}
              leading={
                <span
                  className="size-5 rounded-full border border-border/40"
                  style={{ backgroundColor: preset.color ?? "var(--accent)" }}
                />
              }
              layout="vertical"
              selected={uiAccentId === preset.id}
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
            <AppearanceSelectableTile
              key={language.id}
              agentId={`appearance-language-${language.id}`}
              group="appearance-language"
              label={language.label}
              leading={
                <span className="text-base leading-none">{language.flag}</span>
              }
              layout="horizontal"
              selected={uiLanguage === language.id}
              onSelect={() => setUiLanguage(language.id)}
            />
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup
        bare
        title={t("settings.homeDashboard", { defaultValue: "Home" })}
      >
        <SettingsSwitchRow
          agentId="appearance-show-time-widget"
          group="appearance"
          label={t("settings.showTimeWidget", {
            defaultValue: "Show time & date",
          })}
          checked={!homeTimeWidgetHidden}
          onCheckedChange={(checked) => setHomeTimeWidgetHidden(!checked)}
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
