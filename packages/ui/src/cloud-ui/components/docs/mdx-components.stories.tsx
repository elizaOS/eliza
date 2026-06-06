import type { Meta, StoryObj } from "@storybook/react";
import { Callout, Cards, Steps, Tabs } from "./mdx-components";

const meta = {
  title: "CloudUI/Docs/MdxComponents",
  component: Callout,
  tags: ["autodocs"],
  argTypes: {
    type: {
      control: "select",
      options: ["default", "info", "warning", "error"],
    },
    emoji: { control: "text" },
    children: { control: "text" },
  },
  args: {
    type: "info",
    emoji: "i",
    children: "Heads up: the docs MDX uses these components for callouts.",
  },
} satisfies Meta<typeof Callout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CalloutInfo: Story = {};

export const CalloutWarning: Story = {
  args: {
    type: "warning",
    emoji: "!",
    children: "API keys are scoped per-environment. Rotate them regularly.",
  },
};

export const CalloutError: Story = {
  args: {
    type: "error",
    emoji: "x",
    children: "The previous agent run failed. Check the logs for details.",
  },
};

export const CardsGrid: Story = {
  render: () => (
    <Cards>
      <Cards.Card
        title="Quickstart"
        href="/docs/quickstart"
        icon={<span>QS</span>}
      >
        Spin up your first Eliza agent in under five minutes.
      </Cards.Card>
      <Cards.Card
        title="API Reference"
        href="/docs/api"
        icon={<span>API</span>}
      >
        Full reference for the ElizaClient and HTTP routes.
      </Cards.Card>
      <Cards.Card
        title="Plugin Guide"
        href="https://example.com/plugins"
        icon={<span>PL</span>}
      >
        Build a plugin with actions, providers, and services.
      </Cards.Card>
    </Cards>
  ),
};

export const StepsList: Story = {
  render: () => (
    <Steps>
      <h3>Install the CLI</h3>
      <p>
        Run <code>bun add -g @elizaos/cli</code> to install the elizaos CLI
        globally.
      </p>
      <h3>Scaffold a project</h3>
      <p>
        Use <code>elizaos create my-agent</code> to scaffold a fresh project
        from the min-project template.
      </p>
      <h3>Start the agent</h3>
      <p>
        Run <code>bun run start</code> inside the project to boot the agent.
      </p>
    </Steps>
  ),
};

export const TabsExample: Story = {
  render: () => (
    <Tabs items={["Bun", "npm", "pnpm"]}>
      <Tabs.Tab>
        <pre>
          <code>bun add @elizaos/core</code>
        </pre>
      </Tabs.Tab>
      <Tabs.Tab>
        <pre>
          <code>npm install @elizaos/core</code>
        </pre>
      </Tabs.Tab>
      <Tabs.Tab>
        <pre>
          <code>pnpm add @elizaos/core</code>
        </pre>
      </Tabs.Tab>
    </Tabs>
  ),
};
