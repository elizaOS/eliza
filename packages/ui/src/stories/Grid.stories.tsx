import type { Meta, StoryObj } from "@storybook/react";
import { Grid } from "../components/ui/grid";

const meta = {
  title: "UI/Grid",
  component: Grid,
  tags: ["autodocs"],
} satisfies Meta<typeof Grid>;

export default meta;
type Story = StoryObj<typeof meta>;

const ColoredBox = ({ color, label }: { color: string; label: string }) => (
  <div
    className="flex items-center justify-center rounded-md p-4 text-sm font-medium text-white"
    style={{ backgroundColor: color, minHeight: 60 }}
  >
    {label}
  </div>
);

const boxes = [
  { color: "#3b82f6", label: "1" },
  { color: "#8b5cf6", label: "2" },
  { color: "#ec4899", label: "3" },
  { color: "#f97316", label: "4" },
];

export const OneColumn: Story = {
  args: {
    columns: 1,
    spacing: "md",
  },
  render: (args) => (
    <Grid {...args}>
      {boxes.map((b) => (
        <ColoredBox key={b.label} color={b.color} label={b.label} />
      ))}
    </Grid>
  ),
};

export const TwoColumns: Story = {
  args: {
    columns: 2,
    spacing: "md",
  },
  render: (args) => (
    <Grid {...args}>
      {boxes.map((b) => (
        <ColoredBox key={b.label} color={b.color} label={b.label} />
      ))}
    </Grid>
  ),
};

export const ThreeColumns: Story = {
  args: {
    columns: 3,
    spacing: "md",
  },
  render: (args) => (
    <Grid {...args}>
      {boxes.map((b) => (
        <ColoredBox key={b.label} color={b.color} label={b.label} />
      ))}
    </Grid>
  ),
};

export const FourColumns: Story = {
  args: {
    columns: 4,
    spacing: "md",
  },
  render: (args) => (
    <Grid {...args}>
      {boxes.map((b) => (
        <ColoredBox key={b.label} color={b.color} label={b.label} />
      ))}
    </Grid>
  ),
};

export const SpacingNone: Story = {
  args: {
    columns: 3,
    spacing: "none",
  },
  render: (args) => (
    <Grid {...args}>
      {boxes.map((b) => (
        <ColoredBox key={b.label} color={b.color} label={b.label} />
      ))}
    </Grid>
  ),
};

export const SpacingSm: Story = {
  args: {
    columns: 3,
    spacing: "sm",
  },
  render: (args) => (
    <Grid {...args}>
      {boxes.map((b) => (
        <ColoredBox key={b.label} color={b.color} label={b.label} />
      ))}
    </Grid>
  ),
};

export const SpacingLg: Story = {
  args: {
    columns: 3,
    spacing: "lg",
  },
  render: (args) => (
    <Grid {...args}>
      {boxes.map((b) => (
        <ColoredBox key={b.label} color={b.color} label={b.label} />
      ))}
    </Grid>
  ),
};
