import { LanguageDropdown } from "@elizaos/app-core/components";
import type { UiLanguage } from "@elizaos/app-core/i18n";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

const meta: Meta<typeof LanguageDropdown> = {
  title: "App Core/LanguageDropdown",
  component: LanguageDropdown,
};
export default meta;

export const Native: StoryObj = {
  render: () => {
    const [lang, setLang] = useState<UiLanguage>("en");
    return (
      <div className="flex items-center gap-4">
        <LanguageDropdown
          uiLanguage={lang}
          setUiLanguage={setLang}
        />
        <span className="text-xs text-muted">Selected: {lang}</span>
      </div>
    );
  },
};

export const Companion: StoryObj = {
  render: () => {
    const [lang, setLang] = useState<UiLanguage>("en");
    return (
      <div
        className="p-4 rounded-lg"
        style={{ background: "rgba(18,22,32,0.96)" }}
      >
        <div className="flex items-center gap-4">
          <LanguageDropdown
            uiLanguage={lang}
            setUiLanguage={setLang}
            variant="companion"
          />
          <span className="text-xs" style={{ color: "rgba(255,255,255,0.5)" }}>
            Companion variant · Selected: {lang}
          </span>
        </div>
      </div>
    );
  },
};
