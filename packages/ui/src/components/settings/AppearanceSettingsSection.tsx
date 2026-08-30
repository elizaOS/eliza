/**
 * Settings → General section (stable registry id: `appearance`): the compact,
 * everyday app preferences that are real and useful in the demo. Accent
 * customization remains backward-compatible in persistence/onboarding but is
 * intentionally not exposed here. Background lives in this section rather
 * than duplicating another top-level Settings destination.
 */

import { useAppSelector, useContentPack } from "../../state";
import { LANGUAGES } from "../shared/LanguageDropdown.helpers";
import { BackgroundSettingsControls } from "./BackgroundSettingsControls";
import { LoadedPacksList } from "./LoadedPacksList";
import { SettingsSelectRow, SettingsSwitchRow } from "./settings-agent-rows";
import { SettingsGroup, SettingsStack } from "./settings-layout";

export function AppearanceSettingsSection() {
  const setUiLanguage = useAppSelector((s) => s.setUiLanguage);
  const uiLanguage = useAppSelector((s) => s.uiLanguage);
  const homeTimeWidgetHidden = useAppSelector((s) => s.homeTimeWidgetHidden);
  const setHomeTimeWidgetHidden = useAppSelector(
    (s) => s.setHomeTimeWidgetHidden,
  );
  const t = useAppSelector((s) => s.t);
  const { activePack, loadedPacks, toggle } = useContentPack();

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("settings.general.display", { defaultValue: "Display" })}
      >
        <SettingsSelectRow
          agentId="general-language"
          group="general"
          label={t("settings.language", { defaultValue: "Language" })}
          value={uiLanguage}
          options={LANGUAGES.map((language) => ({
            value: language.id,
            label: `${language.flag} ${language.label}`,
            textValue: language.label,
          }))}
          onValueChange={(value) => setUiLanguage(value as typeof uiLanguage)}
        />
      </SettingsGroup>

      <SettingsGroup
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
        title={t("settings.sections.background.label", {
          defaultValue: "Wallpaper",
        })}
      >
        <BackgroundSettingsControls variant="filmstrip" className="p-4" />
      </SettingsGroup>

      <LoadedPacksList
        loadedPacks={loadedPacks}
        activePackId={activePack?.manifest.id ?? null}
        onToggle={toggle}
      />
    </SettingsStack>
  );
}
