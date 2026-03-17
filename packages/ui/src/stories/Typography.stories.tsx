import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Heading, Text } from "../components/ui/typography";

const meta: Meta<typeof Text> = { title: "Atoms/Typography", component: Text };
export default meta;

export const Headings: StoryObj = {
  render: () => (
    <div className="space-y-3">
      <Heading level="h1">Agent Dashboard</Heading>
      <Heading level="h2">Conversations</Heading>
      <Heading level="h3">Settings</Heading>
      <Heading level="h4">API Keys</Heading>
    </div>
  ),
};

export const TextVariants: StoryObj = {
  render: () => (
    <div className="space-y-2">
      <Text variant="large">Deploy your agent in seconds</Text>
      <Text variant="lead">Connect, configure, launch.</Text>
      <Text>Standard body text for content areas.</Text>
      <Text variant="small">Last updated 2 min ago</Text>
      <Text variant="muted">v1.0.0-beta</Text>
    </div>
  ),
};
