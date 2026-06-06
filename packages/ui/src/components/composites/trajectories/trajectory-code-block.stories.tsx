import type { Meta, StoryObj } from "@storybook/react";
import { TrajectoryCodeBlock } from "./trajectory-code-block";

const SHORT_CONTENT = `const greet = (name: string) => {
  return \`Hello, \${name}!\`;
};

greet("world");`;

const LONG_CONTENT = Array.from(
  { length: 40 },
  (_, i) => `line ${i + 1}: console.log("trajectory step ${i + 1}");`,
).join("\n");

const meta = {
  title: "Composites/Trajectories/TrajectoryCodeBlock",
  component: TrajectoryCodeBlock,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    content: { control: "text" },
    copyLabel: { control: "text" },
    expandLabel: { control: "text" },
    collapseLabel: { control: "text" },
    linesLabel: { control: "text" },
    copyToClipboardLabel: { control: "text" },
    onCopy: { action: "copy" },
  },
  args: {
    label: "Tool input",
    content: SHORT_CONTENT,
    copyLabel: "Copy",
    expandLabel: "Expand",
    collapseLabel: "Collapse",
    linesLabel: "5 lines",
    copyToClipboardLabel: "Copy to clipboard",
    onCopy: () => {},
  },
} satisfies Meta<typeof TrajectoryCodeBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Truncated: Story = {
  args: {
    label: "Tool output",
    content: LONG_CONTENT,
    linesLabel: "40 lines",
  },
};

export const SingleLine: Story = {
  args: {
    label: "Command",
    content: "bun run --cwd packages/ui test",
    linesLabel: "1 line",
  },
};

export const JsonPayload: Story = {
  args: {
    label: "Response body",
    linesLabel: "8 lines",
    content: JSON.stringify(
      {
        status: "ok",
        agent: "eliza",
        steps: [
          { id: 1, action: "search", query: "weather in SF" },
          { id: 2, action: "respond", text: "It is 64F and sunny." },
        ],
      },
      null,
      2,
    ),
  },
};

export const Empty: Story = {
  args: {
    label: "Empty payload",
    content: "",
    linesLabel: "0 lines",
  },
};
