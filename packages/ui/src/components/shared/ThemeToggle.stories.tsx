/** Storybook stories for ThemeToggle: light/dark and the titlebar variant (render fn holds local theme state so the icon flips on click). */

import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import type { UiTheme } from "../../state/persistence";
import { ThemeToggle } from "./ThemeToggle";

const meta = {
  title: "Shared/ThemeToggle",
  component: ThemeToggle,
  tags: ["autodocs"],
  argTypes: {
    uiTheme: { control: "inline-radio", options: ["light", "dark"] },
    variant: {
      control: "inline-radio",
      options: ["native", "companion", "titlebar"],
    },
    setUiTheme: { control: false },
  },
  args: {
    uiTheme: "light",
    variant: "native",
    setUiTheme: () => {},
  },
  render: (args) => {
    const [theme, setTheme] = useState<UiTheme>(args.uiTheme);
    return <ThemeToggle {...args} uiTheme={theme} setUiTheme={setTheme} />;
  },
} satisfies Meta<typeof ThemeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Light theme — shows the moon icon (click to switch to dark). */
export const Default: Story = {};

/** Dark theme — shows the sun icon (click to switch to light). */
export const Dark: Story = { args: { uiTheme: "dark" } };

/** Compact titlebar variant: transparent background, no ring. */
export const Titlebar: Story = { args: { variant: "titlebar" } };
