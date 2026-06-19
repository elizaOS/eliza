import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import type { UiLanguage } from "../../i18n/messages";
import { LanguageDropdown } from "./LanguageDropdown";

const meta = {
  title: "Shared/LanguageDropdown",
  component: LanguageDropdown,
  tags: ["autodocs"],
  argTypes: {
    uiLanguage: {
      control: "select",
      options: ["en", "zh-CN", "ko", "es", "pt", "vi", "tl", "ja"],
    },
    variant: {
      control: "select",
      options: ["native", "companion", "titlebar"],
    },
    menuPlacement: {
      control: "select",
      options: ["bottom-end", "top-end"],
    },
    className: { control: "text" },
    triggerClassName: { control: "text" },
  },
  args: {
    uiLanguage: "en" as UiLanguage,
    setUiLanguage: () => {},
    variant: "native",
    menuPlacement: "bottom-end",
  },
  decorators: [
    (Story, ctx) => {
      const [lang, setLang] = useState<UiLanguage>(
        (ctx.args.uiLanguage as UiLanguage) ?? "en",
      );
      return (
        <div
          style={{ padding: "2rem", display: "flex", justifyContent: "center" }}
        >
          <Story
            args={{ ...ctx.args, uiLanguage: lang, setUiLanguage: setLang }}
          />
        </div>
      );
    },
  ],
} satisfies Meta<typeof LanguageDropdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Spanish: Story = {
  args: {
    uiLanguage: "es",
  },
};

export const Japanese: Story = {
  args: {
    uiLanguage: "ja",
  },
};

export const TitlebarVariant: Story = {
  args: {
    variant: "titlebar",
    uiLanguage: "ko",
  },
};

export const CompanionVariant: Story = {
  args: {
    variant: "companion",
    uiLanguage: "zh-CN",
    menuPlacement: "top-end",
  },
};
