/**
 * Storybook stories for the Eliza logo mark.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ElizaLogo } from "./eliza-logo";

const meta = {
  title: "CloudUI/Brand/ElizaLogo",
  component: ElizaLogo,
  tags: ["autodocs"],
  argTypes: {
    className: { control: "text" },
  },
  args: {
    style: { height: 48, width: "auto" },
  },
} satisfies Meta<typeof ElizaLogo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Small: Story = {
  args: {
    style: { height: 24, width: "auto" },
  },
};

export const Large: Story = {
  args: {
    style: { height: 96, width: "auto" },
  },
};

export const OnDarkBackground: Story = {
  args: {
    style: { height: 64, width: "auto" },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          backgroundColor: "#0a0a0a",
          padding: 48,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export const InHeader: Story = {
  args: {
    style: { height: 32, width: "auto" },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          backgroundColor: "#111",
          padding: "12px 24px",
          display: "flex",
          alignItems: "center",
          gap: 16,
          borderBottom: "1px solid #222",
        }}
      >
        <Story />
        <span style={{ color: "#fff", fontFamily: "sans-serif", fontSize: 14 }}>
          Cloud Dashboard
        </span>
      </div>
    ),
  ],
};
