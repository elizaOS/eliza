/** Storybook stories for PluginVisual, rendering its icon/artwork across sample PluginInfo shapes. */

import type { Meta, StoryObj } from "@storybook/react";
import type { PluginInfo } from "../../api";
import { PluginVisual } from "./PluginVisual";

function makePlugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "example-plugin",
    name: "Example Plugin",
    description: "A sample plugin used for visual stories.",
    ...overrides,
  } as PluginInfo;
}

const meta = {
  title: "Pages/PluginVisual",
  component: PluginVisual,
  tags: ["autodocs"],
} satisfies Meta<typeof PluginVisual>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProviderLogo: Story = {
  args: {
    plugin: makePlugin({ id: "openai", name: "OpenAI" }),
    size: "md",
  },
};

export const ExplicitImage: Story = {
  args: {
    plugin: makePlugin({
      id: "custom-with-image",
      name: "Custom Plugin",
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%23f97316'/%3E%3Ctext x='32' y='39' text-anchor='middle' font-family='sans-serif' font-size='22' font-weight='700' fill='white'%3ECP%3C/text%3E%3C/svg%3E",
    } as Partial<PluginInfo>),
    size: "md",
  },
};

export const MonogramTile: Story = {
  args: {
    plugin: makePlugin({ id: "weather-radar", name: "Weather Radar" }),
    size: "md",
  },
};

export const Large: Story = {
  args: {
    plugin: makePlugin({ id: "task-scheduler", name: "Task Scheduler" }),
    size: "lg",
  },
};

export const Gallery: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <PluginVisual
        plugin={makePlugin({ id: "anthropic", name: "Anthropic" })}
      />
      <PluginVisual plugin={makePlugin({ id: "groq", name: "Groq" })} />
      <PluginVisual plugin={makePlugin({ id: "discord", name: "Discord" })} />
      <PluginVisual
        plugin={makePlugin({ id: "memory-vault", name: "Memory Vault" })}
      />
      <PluginVisual
        plugin={makePlugin({ id: "alpha-bridge", name: "Alpha Bridge" })}
        size="lg"
      />
    </div>
  ),
};
