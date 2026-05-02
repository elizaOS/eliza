"use client";

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bot, Shield, Zap } from "lucide-react";
import { AgentCard, BrandCard } from "./brand-card";

const meta: Meta<typeof BrandCard> = {
  title: "Brand/BrandCard",
  component: BrandCard,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div
        style={{
          backgroundColor: "#0a0a0a",
          padding: "2rem",
          maxWidth: "400px",
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof BrandCard>;

export const Default: Story = {
  args: {
    children: (
      <div>
        <h3
          style={{
            color: "white",
            fontSize: "1.25rem",
            fontWeight: "bold",
            marginBottom: "0.5rem",
          }}
        >
          Card Title
        </h3>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: "0.875rem" }}>
          A brand card with corner brackets and the standard dark theme.
        </p>
      </div>
    ),
  },
};

export const WithHover: Story = {
  args: {
    hover: true,
    children: (
      <div>
        <h3
          style={{
            color: "white",
            fontSize: "1.25rem",
            fontWeight: "bold",
            marginBottom: "0.5rem",
          }}
        >
          Hover Me
        </h3>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: "0.875rem" }}>
          This card has hover effects enabled.
        </p>
      </div>
    ),
  },
};

export const NoCorners: Story = {
  args: {
    corners: false,
    children: <p style={{ color: "white" }}>A card without corner brackets.</p>,
  },
};

export const AgentCardExample: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <AgentCard
        title="AI Assistant"
        description="A helpful conversational agent"
        icon={<Bot className="h-6 w-6" />}
        color="#FF5800"
      />
      <AgentCard
        title="Speed Daemon"
        description="Optimized for fast responses"
        icon={<Zap className="h-6 w-6" />}
        color="#FFD700"
      />
      <AgentCard
        title="Guardian"
        description="Security-focused agent"
        icon={<Shield className="h-6 w-6" />}
        color="#4CAF50"
      />
    </div>
  ),
};
