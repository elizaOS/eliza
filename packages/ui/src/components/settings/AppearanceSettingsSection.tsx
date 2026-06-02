import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useAgentElement } from "../../agent-surface";
import { useApp, useContentPack } from "../../state";
import { LANGUAGES } from "../shared/LanguageDropdown";
import { selectableTileClass } from "./appearance-primitives";
import { LoadContentPackForm } from "./LoadContentPackForm";
import { LoadedPacksList } from "./LoadedPacksList";

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

function ThemeModeButton({
  modeId,
  active,
  icon,
  label,
  onClick,
}: {
  modeId: string;
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `appearance-mode-${modeId}`,
    role: "tab",
    label,
    group: "appearance-mode",
    status: active ? "active" : "inactive",
    onActivate: onClick,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "true" : undefined}
      title={label}
      className={`flex h-10 w-10 items-center justify-center rounded-sm border text-sm font-medium transition-colors ${
        active
          ? "border-accent bg-accent/8 text-txt"
          : "border-border/50 text-muted hover:border-accent/40 hover:bg-bg-hover hover:text-txt"
      }`}
      {...agentProps}
    >
      {icon}
    </button>
  );
}

export function AppearanceSettingsSection() {
  const { setUiLanguage, uiThemeMode, uiLanguage, setUiThemeMode, t } =
    useApp();
  const { activePack, loadedPacks, toggle } = useContentPack();

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          {t("settings.language", { defaultValue: "Language" })}
        </h3>
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
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          {t("settings.appearance.mode", { defaultValue: "Mode" })}
        </h3>
        <div className="flex gap-2">
          <ThemeModeButton
            modeId="system"
            active={uiThemeMode === "system"}
            icon={<Monitor className="h-4 w-4" />}
            label={t("settings.appearance.system", { defaultValue: "System" })}
            onClick={() => setUiThemeMode("system")}
          />
          <ThemeModeButton
            modeId="light"
            active={uiThemeMode === "light"}
            icon={<Sun className="h-4 w-4" />}
            label={t("settings.appearance.light", { defaultValue: "Light" })}
            onClick={() => setUiThemeMode("light")}
          />
          <ThemeModeButton
            modeId="dark"
            active={uiThemeMode === "dark"}
            icon={<Moon className="h-4 w-4" />}
            label={t("settings.appearance.dark", { defaultValue: "Dark" })}
            onClick={() => setUiThemeMode("dark")}
          />
        </div>
      </section>

      <LoadedPacksList
        loadedPacks={loadedPacks}
        activePackId={activePack?.manifest.id ?? null}
        onToggle={toggle}
      />

      <LoadContentPackForm />
    </div>
  );
}
