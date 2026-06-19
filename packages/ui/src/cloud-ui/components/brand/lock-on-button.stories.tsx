import type { Meta, StoryObj } from "@storybook/react";
import { LockOnButton } from "./lock-on-button";

const LockIcon = () => (
  <svg
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <title>Lock</title>
    <path
      d="M5 11h14v10H5zM8 11V7a4 4 0 1 1 8 0v4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const meta = {
  title: "CloudUI/Brand/LockOnButton",
  component: LockOnButton,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["primary", "outline", "ghost", "hud"],
    },
    size: { control: "select", options: ["sm", "md", "lg"] },
    disabled: { control: "boolean" },
    children: { control: "text" },
  },
  args: {
    variant: "primary",
    size: "md",
    children: "Lock On",
    onClick: () => {},
  },
} satisfies Meta<typeof LockOnButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};

export const Outline: Story = {
  args: {
    variant: "outline",
    children: "View details",
  },
};

export const Ghost: Story = {
  args: {
    variant: "ghost",
    children: "Cancel",
  },
};

export const Hud: Story = {
  args: {
    variant: "hud",
    children: "Engage",
    icon: <LockIcon />,
  },
};

export const WithIcon: Story = {
  args: {
    variant: "primary",
    children: "Secure session",
    icon: <LockIcon />,
  },
};

export const Sizes: Story = {
  render: (args) => (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <LockOnButton {...args} size="sm">
        Small
      </LockOnButton>
      <LockOnButton {...args} size="md">
        Medium
      </LockOnButton>
      <LockOnButton {...args} size="lg">
        Large
      </LockOnButton>
    </div>
  ),
};

export const Disabled: Story = {
  args: {
    disabled: true,
    children: "Locked",
    icon: <LockIcon />,
  },
};
