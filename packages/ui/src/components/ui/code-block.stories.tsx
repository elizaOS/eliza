/**
 * Storybook stories for the code-block primitive (syntax display with optional copy button).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { CodeBlock } from "./code-block";

const sampleCode = `import { CodeBlock } from "@elizaos/ui";

export function Example() {
  return <CodeBlock value="hello" copyable />;
}`;

const meta = {
  title: "Primitives/CodeBlock",
  component: CodeBlock,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "select", options: ["block", "inline"] },
    wrap: { control: "boolean" },
    copyable: { control: "boolean" },
    value: { control: "text" },
  },
  args: { value: sampleCode, variant: "block", wrap: false, copyable: false },
} satisfies Meta<typeof CodeBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Copyable: Story = { args: { copyable: true } };

export const Wrapped: Story = {
  args: {
    value:
      "const message = 'This is a single very long line of code that would otherwise overflow horizontally, but wrap keeps it visible by breaking onto multiple lines.';",
    wrap: true,
  },
};

export const Inline: Story = {
  args: { variant: "inline", value: "bun run build" },
};
