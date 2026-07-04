/**
 * Storybook stories for BrandCard / AgentCard (cloud brand card skins).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { AgentCard, BrandCard } from "./brand-card";

const meta = {
  title: "CloudUI/Brand/BrandCard",
  component: BrandCard,
  tags: ["autodocs"],
  argTypes: {
    hover: { control: "boolean" },
    corners: { control: "boolean" },
    cornerSize: { control: "select", options: ["sm", "md", "lg", "xl"] },
    cornerColor: { control: "color" },
    children: { control: false },
  },
  args: {
    hover: false,
    corners: true,
    cornerSize: "md",
    children: (
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Production deployment</h3>
        <p className="text-sm text-muted-foreground">
          Streaming logs from the last 24 hours across all regions.
        </p>
      </div>
    ),
  },
  decorators: [
    (Story) => (
      <div className="p-8 bg-bg max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BrandCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Hoverable: Story = {
  args: { hover: true },
};

export const WithoutCorners: Story = {
  args: { corners: false },
};

export const LargeCornersAccent: Story = {
  args: {
    cornerSize: "lg",
    cornerColor: "#ff6a00",
    hover: true,
  },
};

export const AsAgentCard: StoryObj = {
  render: () => (
    <div className="grid gap-4 max-w-md">
      <AgentCard
        title="Scheduler"
        description="Coordinates timed tasks and watcher fires across LifeOps and Health."
        icon={
          <img
            src="https://placehold.co/24x24/ff6a00/ffffff?text=S"
            alt=""
            width={24}
            height={24}
          />
        }
        color="#ff6a00"
        action={
          <button
            type="button"
            className="text-sm font-medium text-txt-strong underline-offset-4 hover:underline"
            onClick={() => {}}
          >
            Open agent
          </button>
        }
      />
      <AgentCard
        title="Memory keeper"
        description="Maintains long-term entity and relationship stores for the household."
        icon={
          <img
            src="https://placehold.co/24x24/f97316/ffffff?text=M"
            alt=""
            width={24}
            height={24}
          />
        }
        color="#f97316"
      />
    </div>
  ),
};
