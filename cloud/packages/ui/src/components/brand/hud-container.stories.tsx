import type { Meta, StoryObj } from "@storybook/react";
import { HUDContainer } from "./hud-container";

const meta: Meta<typeof HUDContainer> = {
  title: "Brand/HUDContainer",
  component: HUDContainer,
  parameters: { backgrounds: { default: "dark" } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 500, padding: 32 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof HUDContainer>;

export const Default: Story = {
  args: {
    children: <div style={{ padding: 24, color: "white" }}>Content inside HUD container</div>,
  },
};

export const SmallCorners: Story = {
  args: {
    cornerSize: "sm",
    children: (
      <div style={{ padding: 16, color: "white", fontSize: 14 }}>Small corner brackets</div>
    ),
  },
};

export const LargeCorners: Story = {
  args: {
    cornerSize: "lg",
    children: <div style={{ padding: 32, color: "white" }}>Large corner brackets</div>,
  },
};

export const NoBorder: Story = {
  args: {
    withBorder: false,
    children: <div style={{ padding: 24, color: "white" }}>No border, just corners</div>,
  },
};
