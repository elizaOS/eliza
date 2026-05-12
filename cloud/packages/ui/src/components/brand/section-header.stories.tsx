"use client";

import type { Meta, StoryObj } from "@storybook/react-vite";
import { SectionHeader, SectionLabel } from "./section-header";

const meta: Meta<typeof SectionHeader> = {
  title: "Brand/SectionHeader",
  component: SectionHeader,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div style={{ backgroundColor: "#0a0a0a", padding: "2rem" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SectionHeader>;

export const Default: Story = {
  args: {
    label: "Features",
    title: "Build with Intelligence",
    description: "Deploy AI agents with enterprise-grade infrastructure",
  },
};

export const CenterAligned: Story = {
  args: {
    label: "Pricing",
    title: "Simple, transparent pricing",
    description: "Start free, scale as you grow",
    align: "center",
  },
};

export const LabelOnly: Story = {
  render: () => <SectionLabel>Latest Updates</SectionLabel>,
};

export const WithoutDescription: Story = {
  args: {
    label: "Agents",
    title: "Your AI Workforce",
  },
};
