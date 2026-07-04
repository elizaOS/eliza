/**
 * Storybook stories for the Settings → Appearance section across theme modes
 * (system/dark/light) and UI language, using a mock App context.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";

const meta = {
  title: "Settings/AppearanceSettingsSection",
  component: AppearanceSettingsSection,
  tags: ["autodocs"],
  decorators: [
    mockApp({ uiLanguage: "en", uiThemeMode: "system" }),
    (Story) => (
      <div className="max-w-2xl p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AppearanceSettingsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const DarkModeSelected: Story = {
  decorators: [mockApp({ uiLanguage: "en", uiThemeMode: "dark" })],
};

export const LightModeSelected: Story = {
  decorators: [mockApp({ uiLanguage: "en", uiThemeMode: "light" })],
};

export const SpanishLanguage: Story = {
  decorators: [mockApp({ uiLanguage: "es", uiThemeMode: "system" })],
};
