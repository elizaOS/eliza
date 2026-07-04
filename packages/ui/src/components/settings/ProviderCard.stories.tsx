/** Storybook fixtures for `ProviderCard`: default, active, selected, warning, and not-configured states, plus a list layout. */

import type { Meta, StoryObj } from "@storybook/react";
import { Cloud, KeyRound, Server, Sparkles } from "lucide-react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { ProviderCard } from "./ProviderCard";

const meta = {
  title: "Settings/ProviderCard",
  component: ProviderCard,
  tags: ["autodocs"],
  decorators: [withMockApp],
  args: {
    id: "openai",
    icon: Cloud,
    label: "OpenAI",
    category: "cloud",
    status: { tone: "ok", label: "Connected" },
    current: false,
    selected: false,
    onSelect: () => {},
  },
  parameters: { layout: "padded" },
  render: (args) => (
    <div className="max-w-sm">
      <ProviderCard {...args} />
    </div>
  ),
} satisfies Meta<typeof ProviderCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Active: Story = {
  args: {
    current: true,
    selected: true,
    status: { tone: "ok", label: "Connected" },
  },
};

export const Selected: Story = {
  args: {
    selected: true,
  },
};

export const Warning: Story = {
  args: {
    id: "anthropic",
    icon: Sparkles,
    label: "Anthropic",
    category: "key",
    status: { tone: "warn", label: "Missing API key" },
  },
};

export const NotConfigured: Story = {
  args: {
    id: "ollama",
    icon: Server,
    label: "Ollama (Local)",
    category: "local",
    status: { tone: "muted", label: "Not configured" },
  },
};

export const List: Story = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-2">
      <ProviderCard
        id="openai"
        icon={Cloud}
        label="OpenAI"
        category="cloud"
        status={{ tone: "ok", label: "Connected" }}
        current
        selected
        onSelect={() => {}}
      />
      <ProviderCard
        id="anthropic"
        icon={Sparkles}
        label="Anthropic"
        category="subscription"
        status={{ tone: "ok", label: "Active subscription" }}
        current={false}
        selected={false}
        onSelect={() => {}}
      />
      <ProviderCard
        id="openrouter"
        icon={KeyRound}
        label="OpenRouter"
        category="key"
        status={{ tone: "warn", label: "Missing API key" }}
        current={false}
        selected={false}
        onSelect={() => {}}
      />
      <ProviderCard
        id="ollama"
        icon={Server}
        label="Ollama (Local)"
        category="local"
        status={{ tone: "muted", label: "Not configured" }}
        current={false}
        selected={false}
        onSelect={() => {}}
      />
    </div>
  ),
};
