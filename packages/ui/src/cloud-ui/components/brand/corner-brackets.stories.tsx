import type { Meta, StoryObj } from "@storybook/react";
import { CornerBrackets } from "./corner-brackets";

const Frame = ({
  children,
  width = 240,
  height = 140,
  label,
}: {
  children: React.ReactNode;
  width?: number;
  height?: number;
  label?: string;
}) => (
  <div
    className="relative bg-zinc-900 text-orange-500"
    style={{ width, height }}
  >
    {label ? (
      <div className="absolute inset-0 flex items-center justify-center text-xs uppercase tracking-widest text-zinc-400">
        {label}
      </div>
    ) : null}
    {children}
  </div>
);

const meta = {
  title: "CloudUI/Brand/CornerBrackets",
  component: CornerBrackets,
  tags: ["autodocs"],
  argTypes: {
    size: { control: "select", options: ["sm", "md", "lg", "xl"] },
    variant: { control: "select", options: ["corners", "full-border"] },
    color: { control: "color" },
    hoverColor: { control: "color" },
    hoverScale: { control: "boolean" },
  },
  args: {
    size: "md",
    variant: "corners",
    hoverScale: false,
  },
  decorators: [
    (Story) => (
      <Frame label="Hover me">
        <Story />
      </Frame>
    ),
  ],
} satisfies Meta<typeof CornerBrackets>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Large: Story = {
  args: {
    size: "lg",
  },
};

export const FullBorder: Story = {
  args: {
    variant: "full-border",
    size: "lg",
  },
};

export const CustomColor: Story = {
  args: {
    size: "lg",
    color: "#f97316",
    variant: "full-border",
  },
};

export const HoverScale: Story = {
  args: {
    size: "lg",
    hoverScale: true,
    hoverColor: "#fb923c",
    variant: "full-border",
  },
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex gap-4">
      {(["sm", "md", "lg", "xl"] as const).map((size) => (
        <Frame key={size} width={140} height={140} label={size}>
          <CornerBrackets size={size} variant="full-border" />
        </Frame>
      ))}
    </div>
  ),
  decorators: [(Story) => <Story />],
};
