/** Storybook fixture composing the Card primitive parts (header/content/footer/action); also feeds the story-gate render check. */
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
      options: [
        "default",
        "setting",
        "flatPadded",
        "outlinedPadded",
        "reportPanel",
        "insetCompact",
        "insetPadded",
        "transparent",
        "dashed",
        "accentTile",
        "brand",
        "panel",
      ],
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
  args: { variant: "flatPadded" },
  render: (args) => (
    <Card {...args} className="w-80">
      <p className="text-sm">A borderless container for inline content.</p>
    </Card>
  ),
};

export const Outlined: Story = {
  args: { variant: "outlinedPadded", stack: "default" },
  render: (args) => (
    <Card {...args} className="w-80">
      <CardTitle>Local model</CardTitle>
      <CardDescription>
        Outlined surface with canonical padding.
      </CardDescription>
    </Card>
  ),
};

export const ReportPanel: Story = {
  args: { variant: "reportPanel" },
  render: (args) => (
    <Card {...args} className="w-80">
      <CardHeader>
        <CardTitle>Provider usage</CardTitle>
        <CardDescription>Analytics report surface.</CardDescription>
      </CardHeader>
    </Card>
  ),
};

export const InsetRow: Story = {
  args: {
    variant: "insetCompact",
    flow: "rowBetween",
    gap: "default",
  },
  render: (args) => (
    <Card {...args} className="w-80">
      <span className="text-sm">Monetization</span>
      <span className="text-sm text-muted">Enabled</span>
    </Card>
  ),
};

export const Dashed: Story = {
  args: { variant: "dashed" },
  render: (args) => (
    <Card {...args} className="w-80 p-8 text-center">
      <CardTitle>No results</CardTitle>
      <CardDescription>Try adjusting the current filters.</CardDescription>
    </Card>
  ),
};

export const Transparent: Story = {
  args: { variant: "transparent" },
  render: (args) => (
    <Card {...args} className="w-80 p-4">
      Transparent grouping surface
    </Card>
  ),
};

export const AccentTile: Story = {
  args: { variant: "accentTile" },
  render: (args) => (
    <Card {...args} className="size-14">
      AI
    </Card>
  ),
};
