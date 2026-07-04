/**
 * Storybook states for the Page Panel Loading page-panel primitive used to
 * compose dense dashboard pages.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { PageLoadingState } from "./page-panel-loading";

const meta = {
  title: "Composites/PagePanel/PagePanelLoading",
  component: PageLoadingState,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["panel", "surface", "workspace"],
    },
    heading: { control: "text" },
    description: { control: "text" },
  },
  args: {
    variant: "panel",
    heading: "Loading workspace",
    description: "Fetching your agents and recent activity.",
  },
} satisfies Meta<typeof PageLoadingState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const HeadingOnly: Story = {
  args: {
    heading: "Loading…",
    description: undefined,
  },
};

export const Surface: Story = {
  args: {
    variant: "surface",
    heading: "Preparing your surface",
    description: "This usually takes a few seconds.",
  },
};

export const Workspace: Story = {
  args: {
    variant: "workspace",
    heading: "Spinning up workspace",
    description: "Connecting to the runtime and syncing state.",
  },
};
