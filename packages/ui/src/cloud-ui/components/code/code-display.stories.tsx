import type { Meta, StoryObj } from "@storybook/react";
import { CodeDisplay } from "./code-display";

const meta = {
  title: "CloudUI/Code/CodeDisplay",
  component: CodeDisplay,
  tags: ["autodocs"],
  argTypes: {
    language: {
      control: "select",
      options: ["bash", "typescript", "tsx", "json", "python", "yaml"],
    },
    code: { control: "text" },
    className: { control: "text" },
  },
  args: {
    language: "bash",
    code: "elizaos create my-agent\ncd my-agent\nbun install\nbun run dev",
  },
} satisfies Meta<typeof CodeDisplay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Bash: Story = {};

export const TypeScript: Story = {
  args: {
    language: "typescript",
    code: `import { AgentRuntime } from "@elizaos/agent";

export async function startAgent() {
  const runtime = new AgentRuntime({
    character: { name: "Eliza", bio: "Helpful assistant" },
  });
  await runtime.start();
  return runtime;
}`,
  },
};

export const Tsx: Story = {
  args: {
    language: "tsx",
    code: `export function Greeting({ name }: { name: string }) {
  // Render a friendly hello
  return <div className="text-lg">Hello, {name}!</div>;
}`,
  },
};

export const Json: Story = {
  args: {
    language: "json",
    code: `{
  "name": "my-agent",
  "version": "1.0.0",
  "plugins": ["@elizaos/plugin-openai", "@elizaos/plugin-discord"],
  "settings": {
    "model": "gpt-4",
    "temperature": 0.7
  }
}`,
  },
};

export const Python: Story = {
  args: {
    language: "python",
    code: `def fibonacci(n: int) -> int:
    """Return the nth Fibonacci number."""
    if n < 2:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)


print(fibonacci(10))`,
  },
};
