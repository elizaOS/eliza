import { Check, Moon, Sun } from "lucide-react";
import { useApp, useContentPack } from "../../state";
import { LANGUAGES } from "../shared/LanguageDropdown";
import { ModeButton, selectableTileClass } from "./appearance-primitives";
import { LoadContentPackForm } from "./LoadContentPackForm";
import { LoadedPacksList } from "./LoadedPacksList";

export function AppearanceSettingsSection() {
  const { activePackId, setUiLanguage, uiTheme, uiLanguage, setUiTheme, t } =
    useApp();
  const { loadedPacks, toggle } = useContentPack();

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

      <LoadedPacksList
        loadedPacks={loadedPacks}
        activePackId={activePackId}
        onToggle={toggle}
      />

      <LoadContentPackForm />
    </div>
  );
}
