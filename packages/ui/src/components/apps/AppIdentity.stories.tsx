import type { Meta, StoryObj } from "@storybook/react";
import {
  AppHero,
  type AppIdentitySource,
  AppIdentityTile,
} from "./app-identity";

const walletApp: AppIdentitySource = {
  name: "wallet",
  displayName: "Wallet",
  category: "money",
  description: "Manage balances and send on-chain transactions.",
};

const gameApp: AppIdentitySource = {
  name: "arcade",
  displayName: "Arcade",
  category: "play",
  description: "A pixel arcade to pass the time.",
};

const toolsApp: AppIdentitySource = {
  name: "toolbox",
  displayName: "Toolbox",
  category: "tools",
  description: "Utilities for everyday agent work.",
};

const meta = {
  title: "Apps/AppIdentityTile",
  component: AppIdentityTile,
  tags: ["autodocs"],
  argTypes: {
    active: { control: "boolean" },
    size: { control: "select", options: ["sm", "md"] },
    imageOnly: { control: "boolean" },
    glyph: { control: "boolean" },
  },
  args: { app: walletApp, size: "md", active: false },
} satisfies Meta<typeof AppIdentityTile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Active: Story = { args: { active: true } };

export const Small: Story = { args: { size: "sm" } };

export const GlyphOnly: Story = { args: { glyph: true } };

/** Each category resolves a different gradient palette and glyph. */
export const Categories: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-4">
      <AppIdentityTile {...args} app={walletApp} glyph />
      <AppIdentityTile {...args} app={gameApp} glyph />
      <AppIdentityTile {...args} app={toolsApp} glyph />
    </div>
  ),
};

/** The full-bleed hero variant used as an app card background. */
export const Hero: StoryObj<typeof AppHero> = {
  render: () => (
    <div className="w-72">
      <AppHero app={walletApp} className="aspect-[5/4] rounded-sm" />
    </div>
  ),
};
