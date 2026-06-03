import type { Meta, StoryObj } from "@storybook/react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card";

const meta = {
  title: "Primitives/Card",
  component: Card,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "interactive", "status", "setting", "flat"],
    },
  },
  args: { variant: "default" },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Card {...args} className="w-80">
      <CardHeader>
        <CardTitle>Agent settings</CardTitle>
        <CardDescription>Manage how your agent responds.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm">
          Configure model, persona, and connectors from a single place.
        </p>
      </CardContent>
      <CardFooter>
        <span className="text-sm text-muted">Last updated just now</span>
      </CardFooter>
    </Card>
  ),
};

export const Interactive: Story = {
  args: { variant: "interactive" },
  render: (args) => (
    <Card {...args} className="w-80">
      <CardHeader>
        <CardTitle>Open chat</CardTitle>
        <CardDescription>Hover to highlight this card.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm">Click anywhere to start a conversation.</p>
      </CardContent>
    </Card>
  ),
};

export const WithAction: Story = {
  render: (args) => (
    <Card
      {...args}
      className="grid w-80 grid-cols-[1fr_auto] grid-rows-[auto_auto]"
    >
      <CardHeader>
        <CardTitle>Webhook</CardTitle>
        <CardDescription>Delivers events to your endpoint.</CardDescription>
      </CardHeader>
      <CardAction>
        <span className="rounded-sm bg-card px-2 py-1 text-xs">Active</span>
      </CardAction>
    </Card>
  ),
};

export const Flat: Story = {
  args: { variant: "flat" },
  render: (args) => (
    <Card {...args} className="w-80 p-4">
      <p className="text-sm">A borderless container for inline content.</p>
    </Card>
  ),
};
