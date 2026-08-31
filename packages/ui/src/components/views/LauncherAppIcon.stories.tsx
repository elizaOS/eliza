/** Storybook states for the shared launcher icon plate and resolver. */
import type { Meta, StoryObj } from "@storybook/react";
import { LauncherAppIcon } from "./LauncherAppIcon";

const meta = {
  title: "Views/LauncherAppIcon",
  component: LauncherAppIcon,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
    backgrounds: { default: "dark" },
  },
  args: {
    entry: { id: "settings", label: "Settings", icon: "Settings" },
    className: "size-20",
  },
} satisfies Meta<typeof LauncherAppIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A curated first-party destination resolves to its canonical filled Ionicon. */
export const FirstParty: Story = {};

/** An unmapped destination uses the deterministic semantic fallback resolver. */
export const SemanticFallback: Story = {
  args: {
    entry: { id: "weather-lab", label: "Weather Lab", icon: "CloudSun" },
  },
};
