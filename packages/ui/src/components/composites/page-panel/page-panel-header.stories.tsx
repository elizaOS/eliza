/**
 * Storybook states for the Page Panel Header page-panel primitive used to
 * compose dense dashboard pages.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "../../ui/button";
import { MetaPill, PanelHeader } from "./page-panel-header";

const meta = {
  title: "Composites/PagePanel/PagePanelHeader",
  component: PanelHeader,
  tags: ["autodocs"],
  argTypes: {
    eyebrow: { control: "text" },
    heading: { control: "text" },
    description: { control: "text" },
    bordered: { control: "boolean" },
  },
  args: {
    heading: "Memory store",
    description: "Persisted facts and embeddings the agent recalls in chat.",
  },
} satisfies Meta<typeof PanelHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithEyebrow: Story = {
  args: {
    eyebrow: "Settings",
    heading: "Model provider",
    description: "Choose which LLM backs this agent's responses.",
  },
};

export const WithActions: Story = {
  args: {
    eyebrow: "Plugins",
    heading: "Installed plugins",
    description: "12 active across this workspace.",
    actions: (
      <>
        <Button variant="ghost" size="sm">
          Refresh
        </Button>
        <Button size="sm">Add plugin</Button>
      </>
    ),
  },
};

export const WithMedia: Story = {
  args: {
    heading: "Discord connector",
    description: "Connected as eliza#0001 in 3 servers.",
    media: <MetaPill tone="accent">Live</MetaPill>,
    actions: (
      <Button variant="outline" size="sm">
        Disconnect
      </Button>
    ),
  },
};

export const HeadingOnly: Story = {
  args: {
    heading: "Recent activity",
    description: undefined,
  },
};
