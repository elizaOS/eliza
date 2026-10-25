/**
 * Storybook stories for SectionHeader / SectionLabel.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { SectionHeader, SectionLabel } from "./section-header";

const meta = {
  title: "CloudUI/Brand/SectionHeader",
  component: SectionHeader,
  tags: ["autodocs"],
  argTypes: {
    align: { control: "select", options: ["left", "center", "right"] },
    label: { control: "text" },
    title: { control: "text" },
    description: { control: "text" },
  },
  args: {
    label: "Platform",
    title: "Build and ship autonomous agents",
    description:
      "Everything you need to design, deploy, and operate Eliza agents at scale.",
    align: "left",
  },
} satisfies Meta<typeof SectionHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LabelOnly: Story = {
  args: {
    label: "Overview",
    title: undefined,
    description: undefined,
  },
};

export const Centered: Story = {
  args: {
    align: "center",
    label: "Pricing",
    title: "Simple, usage-based pricing",
    description:
      "Pay only for the compute and tokens your agents actually use. No seats, no minimums, no surprises.",
  },
};

export const RightAligned: Story = {
  args: {
    align: "right",
    label: "Roadmap",
    title: "What's shipping next",
    description: "A peek at the features landing in the coming weeks.",
  },
};

export const RichDescription: Story = {
  args: {
    label: "Docs",
    title: "Get started in minutes",
    description: (
      <>
        Follow the <strong>quickstart</strong> guide, or jump straight into the{" "}
        <a href="/docs/api" className="underline">
          API reference
        </a>
        .
      </>
    ),
  },
};

export const LabelComponent: StoryObj = {
  name: "SectionLabel (standalone)",
  render: () => (
    <div className="space-y-4">
      <SectionLabel>Features</SectionLabel>
      <SectionLabel>Integrations</SectionLabel>
      <SectionLabel className="opacity-60">Coming soon</SectionLabel>
    </div>
  ),
};
