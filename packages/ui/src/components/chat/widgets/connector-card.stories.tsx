/**
 * Storybook + story-gate visual states for the inline ConnectorCardWidget.
 * The card fetches its own plugin state through the typed client, so outside a
 * live app runtime it renders its loading state — classified `needs-runtime`
 * by the story gate; the live states are covered by connector-card.test.tsx
 * and the full-app audit.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ConnectorCardWidget } from "./connector-card";

const meta = {
  title: "Chat/Widgets/ConnectorCard",
  component: ConnectorCardWidget,
  tags: ["autodocs"],
} satisfies Meta<typeof ConnectorCardWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Slack: Story = {
  args: { pluginId: "slack" },
};

export const GoogleWorkspace: Story = {
  args: { pluginId: "google-workspace" },
};
