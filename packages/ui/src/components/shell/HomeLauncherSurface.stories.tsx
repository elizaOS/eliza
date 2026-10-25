/** Home and launcher rail states with both halves mounted for swipe review. */

import type { Meta, StoryObj } from "@storybook/react";
import { HomeLauncherSurface } from "./HomeLauncherSurface";

const panelClass =
  "grid h-full place-items-center text-2xl font-semibold text-white";

const meta = {
  title: "Shell/HomeLauncherSurface",
  component: HomeLauncherSurface,
  parameters: { layout: "fullscreen" },
  args: {
    home: <div className={`${panelClass} bg-neutral-900`}>Home widgets</div>,
    launcher: (
      <div className={`${panelClass} bg-neutral-800`}>Application launcher</div>
    ),
    initialPage: "home",
  },
} satisfies Meta<typeof HomeLauncherSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Home: Story = {};
export const Launcher: Story = { args: { initialPage: "launcher" } };
