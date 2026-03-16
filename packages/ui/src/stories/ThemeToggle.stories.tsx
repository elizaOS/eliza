import { ThemeToggle } from "@milady/app-core/components";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";

const meta = {
  title: "Controls/ThemeToggle",
  component: ThemeToggle,
  parameters: {
    layout: "centered",
  },
  args: {
    uiTheme: "dark",
    setUiTheme: fn(),
    t: (key: string) => key,
  },
} satisfies Meta<typeof ThemeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NativeDark: Story = {
  args: {
    variant: "native",
    uiTheme: "dark",
  },
};

export const NativeLight: Story = {
  args: {
    variant: "native",
    uiTheme: "light",
  },
};

export const CompanionDark: Story = {
  args: {
    variant: "companion",
    uiTheme: "dark",
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background: "rgba(0,0,0,0.8)",
          padding: "2rem",
          borderRadius: "1rem",
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export const CompanionLight: Story = {
  args: {
    variant: "companion",
    uiTheme: "light",
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background: "rgba(0,0,0,0.8)",
          padding: "2rem",
          borderRadius: "1rem",
        }}
      >
        <Story />
      </div>
    ),
  ],
};
