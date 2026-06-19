import type { Meta, StoryObj } from "@storybook/react";
import { Spotlight } from "./spotlight";

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      position: "relative",
      width: "100%",
      height: 480,
      background: "#0a0a0a",
      overflow: "hidden",
      borderRadius: 12,
    }}
  >
    {children}
    <div
      style={{
        position: "relative",
        zIndex: 2,
        padding: 48,
        color: "#fafafa",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 36, margin: 0, fontWeight: 700 }}>
        Spotlight overlay
      </h1>
      <p style={{ marginTop: 12, opacity: 0.7, maxWidth: 420 }}>
        A blurred, animated SVG ellipse used as a hero background accent in the
        cloud dashboard.
      </p>
    </div>
  </div>
);

const meta = {
  title: "CloudUI/Components/Spotlight",
  component: Spotlight,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <Stage>
        <Story />
      </Stage>
    ),
  ],
  argTypes: {
    fill: { control: "color" },
    className: { control: "text" },
  },
} satisfies Meta<typeof Spotlight>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    className: "-top-40 left-0 md:-top-20 md:left-60",
  },
};

export const WarmFill: Story = {
  args: {
    fill: "#ff8a3d",
    className: "-top-40 left-0 md:-top-20 md:left-60",
  },
};

export const CoolFill: Story = {
  args: {
    fill: "#7dd3fc",
    className: "-top-40 left-0 md:-top-20 md:left-60",
  },
};

export const CenterStage: Story = {
  args: {
    fill: "#ffffff",
    className: "top-0 left-1/2 -translate-x-1/2",
  },
};
