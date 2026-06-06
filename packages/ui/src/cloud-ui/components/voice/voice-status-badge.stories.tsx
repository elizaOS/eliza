import type { Meta, StoryObj } from "@storybook/react";
import { VoiceStatusBadge } from "./voice-status-badge";

const now = Date.now();
const minutes = (n: number) => new Date(now - n * 60 * 1000);

const meta = {
  title: "CloudUI/Voice/VoiceStatusBadge",
  component: VoiceStatusBadge,
  tags: ["autodocs"],
} satisfies Meta<typeof VoiceStatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InstantReady: Story = {
  args: {
    voice: {
      cloneType: "instant",
      createdAt: minutes(2),
    },
  },
};

export const ProfessionalProcessing: Story = {
  args: {
    voice: {
      cloneType: "professional",
      createdAt: minutes(10),
      status: "processing",
    },
  },
};

export const ProfessionalFinalizing: Story = {
  args: {
    voice: {
      cloneType: "professional",
      createdAt: minutes(45),
      status: "processing",
    },
  },
};

export const ProfessionalReady: Story = {
  args: {
    voice: {
      cloneType: "professional",
      createdAt: minutes(75),
      status: "completed",
    },
  },
};

export const ProfessionalFailed: Story = {
  args: {
    voice: {
      cloneType: "professional",
      createdAt: minutes(20),
      status: "failed",
    },
  },
};
