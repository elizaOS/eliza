import type { Meta, StoryObj } from "@storybook/react";
import { CompanionHeader } from "./CompanionHeader";

const meta = {
  title: "Companion/CompanionHeader",
  component: CompanionHeader,
  tags: ["autodocs"],
  argTypes: {
    activeView: {
      control: "select",
      options: ["companion", "character"],
    },
    chatAgentVoiceMuted: { control: "boolean" },
  },
  args: {
    activeView: "companion",
    uiLanguage: "en" as const,
    setUiLanguage: () => {},
    uiTheme: "dark" as const,
    setUiTheme: () => {},
    t: (key: string) => key,
    onExitToDesktop: () => {},
    onExitToCharacter: () => {},
    onSwitchToCompanion: () => {},
    onToggleVoiceMute: () => {},
    onNewChat: () => {},
    chatAgentVoiceMuted: false,
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof CompanionHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const CharacterView: Story = {
  args: { activeView: "character" },
};

export const VoiceMuted: Story = {
  args: { chatAgentVoiceMuted: true },
};
