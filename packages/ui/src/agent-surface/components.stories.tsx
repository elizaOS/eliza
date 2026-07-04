/**
 * Storybook stories for the agent-surface primitive components (AgentButton, AgentInput, IconTag).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { CheckCircle2, Sparkles } from "lucide-react";
import { AgentButton, AgentInput, IconTag } from "./components";

/**
 * IconTag — compact graphic-first chip used to replace bare text tags. The
 * sibling agent primitives (AgentButton, AgentInput) are story-able too and
 * render their inert props without an AgentSurfaceProvider.
 */
const meta = {
  title: "AgentSurface/IconTag",
  component: IconTag,
  tags: ["autodocs"],
  argTypes: {
    tone: {
      control: "select",
      options: ["neutral", "accent", "success", "warning", "danger"],
    },
    label: { control: "text" },
    status: { control: "text" },
  },
  args: {
    label: "Synced",
    tone: "neutral",
  },
} satisfies Meta<typeof IconTag>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithIcon: Story = {
  args: {
    icon: CheckCircle2,
    label: "Verified",
    tone: "success",
    status: "active",
  },
};

export const AllTones: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <IconTag label="Neutral" tone="neutral" />
      <IconTag icon={Sparkles} label="Accent" tone="accent" />
      <IconTag icon={CheckCircle2} label="Success" tone="success" />
      <IconTag label="Warning" tone="warning" />
      <IconTag label="Danger" tone="danger" />
    </div>
  ),
};

export const AgentButtonExample: Story = {
  render: () => (
    <AgentButton
      agentId="send-tx"
      agentLabel="Send transaction"
      agentStatus="active"
      className="rounded-md border border-border bg-accent-subtle px-3 py-1.5 text-sm font-medium text-accent"
    >
      Send transaction
    </AgentButton>
  ),
};

export const AgentInputExample: Story = {
  render: () => (
    <AgentInput
      agentId="recipient"
      agentLabel="Recipient address"
      placeholder="0x..."
      className="w-72 rounded-md border border-border bg-bg-muted px-3 py-1.5 text-sm text-text"
    />
  ),
};
