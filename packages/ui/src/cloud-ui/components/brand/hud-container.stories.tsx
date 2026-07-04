/**
 * Storybook stories for HUDContainer.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { HUDContainer } from "./hud-container";

const meta = {
  title: "CloudUI/Brand/HUDContainer",
  component: HUDContainer,
  tags: ["autodocs"],
  argTypes: {
    cornerSize: {
      control: "select",
      options: ["sm", "md", "lg", "xl"],
    },
    cornerColor: { control: "color" },
  },
  args: {
    cornerSize: "md",
  },
  decorators: [
    (Story) => (
      <div style={{ padding: 48, background: "#0a0a0a", minHeight: 240 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof HUDContainer>;

export default meta;
type Story = StoryObj<typeof meta>;

const SamplePanel = ({ title, body }: { title: string; body: string }) => (
  <div style={{ padding: 24 }}>
    <h3
      style={{
        margin: 0,
        marginBottom: 8,
        fontSize: 14,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "#f97316",
      }}
    >
      {title}
    </h3>
    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "#d4d4d4" }}>
      {body}
    </p>
  </div>
);

export const Default: Story = {
  args: {
    children: (
      <SamplePanel
        title="System Status"
        body="All agents nominal. Telemetry streaming at 60Hz."
      />
    ),
  },
};

export const SmallCorners: Story = {
  args: {
    cornerSize: "sm",
    children: (
      <SamplePanel
        title="Compact Readout"
        body="Tight corner brackets suit dense data layouts."
      />
    ),
  },
};

export const LargeCorners: Story = {
  args: {
    cornerSize: "lg",
    children: (
      <SamplePanel
        title="Mission Brief"
        body="Larger brackets emphasize the framed content."
      />
    ),
  },
};

export const ExtraLargeCorners: Story = {
  args: {
    cornerSize: "xl",
    children: (
      <SamplePanel
        title="Primary Console"
        body="XL brackets for hero panels and focus views."
      />
    ),
  },
};

export const CustomCornerColor: Story = {
  args: {
    cornerSize: "lg",
    cornerColor: "#22d3ee",
    children: (
      <SamplePanel
        title="Diagnostic Mode"
        body="Override the corner color for state-specific HUDs."
      />
    ),
  },
};

export const WithImage: Story = {
  args: {
    cornerSize: "md",
    className: "w-[320px]",
    children: (
      <div style={{ padding: 16 }}>
        <img
          src="https://placehold.co/288x160/0a0a0a/f97316?text=TELEMETRY"
          alt="telemetry"
          style={{ width: "100%", display: "block", borderRadius: 2 }}
        />
        <div style={{ marginTop: 12, fontSize: 12, color: "#a3a3a3" }}>
          Live feed - sector 7G
        </div>
      </div>
    ),
  },
};
