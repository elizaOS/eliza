/**
 * Storybook states for the Page Panel Empty page-panel primitive used to
 * compose dense dashboard pages.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "../../ui/button";
import { PageEmptyState } from "./page-panel-empty";

const meta = {
  title: "Composites/PagePanel/PagePanelEmpty",
  component: PageEmptyState,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["panel", "inset", "surface", "workspace"],
    },
    title: { control: "text" },
    description: { control: "text" },
  },
  args: {
    title: "No agents yet",
    description: "Create your first agent to start a conversation.",
    variant: "panel",
  },
} satisfies Meta<typeof PageEmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Inset: Story = { args: { variant: "inset" } };

export const Surface: Story = { args: { variant: "surface" } };

export const Workspace: Story = { args: { variant: "workspace" } };

export const WithAction: Story = {
  args: {
    title: "No conversations",
    description: "Start a new chat to see it appear here.",
    action: <Button>New chat</Button>,
  },
};
