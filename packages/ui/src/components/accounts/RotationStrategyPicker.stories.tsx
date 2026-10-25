/** Storybook stories for RotationStrategyPicker across the account rotation strategies, under the shared MockAppProvider. */

import type { Meta, StoryObj } from "@storybook/react";
import { MockAppProvider } from "../../storybook/mock-providers";
import { RotationStrategyPicker } from "./RotationStrategyPicker";

const meta = {
  title: "Accounts/RotationStrategyPicker",
  component: RotationStrategyPicker,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <MockAppProvider>
        <div className="p-6">
          <Story />
        </div>
      </MockAppProvider>
    ),
  ],
  argTypes: {
    providerId: { control: "text" },
    value: {
      control: "select",
      options: [
        undefined,
        "priority",
        "round-robin",
        "least-used",
        "quota-aware",
      ],
    },
    disabled: { control: "boolean" },
    onChange: { action: "changed" },
  },
  args: {
    providerId: "openai",
    value: "priority",
    disabled: false,
    onChange: () => {},
  },
} satisfies Meta<typeof RotationStrategyPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const RoundRobin: Story = {
  args: {
    providerId: "anthropic",
    value: "round-robin",
  },
};

export const LeastUsed: Story = {
  args: {
    providerId: "openrouter",
    value: "least-used",
  },
};

export const QuotaAware: Story = {
  args: {
    providerId: "groq",
    value: "quota-aware",
  },
};

export const Unset: Story = {
  args: {
    providerId: "xai",
    value: undefined,
  },
};

export const Disabled: Story = {
  args: {
    providerId: "google-genai",
    value: "priority",
    disabled: true,
  },
};
