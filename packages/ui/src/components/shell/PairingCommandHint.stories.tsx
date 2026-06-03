import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers";
import { PairingCommandHint } from "./PairingCommandHint";

const meta = {
  title: "Shell/PairingCommandHint",
  component: PairingCommandHint,
  tags: ["autodocs"],
  decorators: [withMockApp],
  argTypes: {
    remoteUrl: { control: "text" },
  },
  args: {
    remoteUrl: "https://agent.example.com",
  },
} satisfies Meta<typeof PairingCommandHint>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RemoteHost: Story = {};

export const RemoteWithPort: Story = {
  args: {
    remoteUrl: "https://agent.example.com:8443",
  },
};

export const Loopback: Story = {
  args: {
    remoteUrl: "http://localhost:2138",
  },
};

export const NoUrl: Story = {
  args: {
    remoteUrl: undefined,
  },
};
