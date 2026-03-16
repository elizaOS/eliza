import { LanguageDropdown } from "@elizaos/app-core/components";
import type { Meta, StoryObj } from "@storybook/react";
import React, { useState } from "react";

const meta: Meta<typeof LanguageDropdown> = {
  title: "App Core/LanguageDropdown",
  component: LanguageDropdown,
};
export default meta;

export const Native: StoryObj = {
  render: () => {
    const [lang, setLang] = useState<string>("en");
    return (
      <div className="flex items-center gap-4">
        <LanguageDropdown
          // biome-ignore lint/suspicious/noExplicitAny: story mock
          uiLanguage={lang as any}
          // biome-ignore lint/suspicious/noExplicitAny: story mock
          setUiLanguage={setLang as any}
        />
        <span className="text-xs text-muted">Selected: {lang}</span>
      </div>
    );
  },
};

export const Companion: StoryObj = {
  render: () => {
    const [lang, setLang] = useState<string>("en");
    return (
      <div
        className="p-4 rounded-lg"
        style={{ background: "rgba(18,22,32,0.96)" }}
      >
        <div className="flex items-center gap-4">
          <LanguageDropdown
            // biome-ignore lint/suspicious/noExplicitAny: story mock
            uiLanguage={lang as any}
            // biome-ignore lint/suspicious/noExplicitAny: story mock
            setUiLanguage={setLang as any}
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
