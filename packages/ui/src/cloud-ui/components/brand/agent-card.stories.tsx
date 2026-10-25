/**
 * Storybook stories for the AgentCard domain composition.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "../../../components/ui/button";
import { AgentCard } from "./agent-card";

const meta = {
  title: "CloudUI/Brand/AgentCard",
  component: AgentCard,
  tags: ["autodocs"],
  args: {
    title: "Scheduler",
    description:
      "Coordinates timed tasks and watcher fires across LifeOps and Health.",
    icon: (
      <img
        src="https://placehold.co/24x24/ff6a00/ffffff?text=S"
        alt=""
        width={24}
        height={24}
      />
    ),
    color: "#ff6a00",
    action: (
      <Button type="button" variant="link" onClick={() => {}}>
        Open agent
      </Button>
    ),
  },
  decorators: [
    (Story) => (
      <div className="max-w-md bg-bg p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AgentCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
