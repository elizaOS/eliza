import { Check } from "lucide-react";
import { useAgentElement } from "../../agent-surface";
import { useAppSelector, useContentPack } from "../../state";
import { LANGUAGES } from "../shared/LanguageDropdown.helpers";
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

export function AppearanceSettingsSection() {
  const setUiLanguage = useAppSelector((s) => s.setUiLanguage);
  const uiLanguage = useAppSelector((s) => s.uiLanguage);
  const t = useAppSelector((s) => s.t);
  const { activePack, loadedPacks, toggle } = useContentPack();
  const advancedEnabled = useAdvancedSettingsEnabled();

  return (
    <SettingsStack>
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
