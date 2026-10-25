/**
 * Storybook stories for `AppIdentityTile` variants — apps with an icon, a hero
 * image, and no art — exercising the tile's asset-fallback rendering.
 */

import type { Meta, StoryObj } from "@storybook/react";
import {
  AppHero,
  type AppIdentitySource,
  AppIdentityTile,
} from "./app-identity";

const sampleApp: AppIdentitySource = {
  name: "calendar",
  displayName: "Calendar",
  category: "productivity",
  description: "Plan your day at a glance.",
  icon: null,
  heroImage: null,
};

const photoApp: AppIdentitySource = {
  name: "photo-stream",
  displayName: "Photo Stream",
  category: "media",
  description: "A scrolling gallery of moments.",
  icon: null,
  heroImage: "https://placehold.co/600x400/0ea5e9/ffffff?text=Hero",
};

const meta = {
  title: "Apps/AppIdentity",
  component: AppIdentityTile,
  tags: ["autodocs"],
  argTypes: {
    size: { control: "select", options: ["sm", "md"] },
    active: { control: "boolean" },
    imageOnly: { control: "boolean" },
    glyph: { control: "boolean" },
  },
  args: {
    app: sampleApp,
    size: "md",
    active: false,
    imageOnly: false,
    glyph: false,
  },
} satisfies Meta<typeof AppIdentityTile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Small: Story = {
  args: { size: "sm" },
};

export const Active: Story = {
  args: { active: true },
};

export const GlyphOnly: Story = {
  args: { glyph: true },
};

export const WithHeroImage: Story = {
  args: { app: photoApp },
};

export const TileGallery: Story = {
  render: () => {
    const apps: AppIdentitySource[] = [
      { name: "calendar", displayName: "Calendar", category: "productivity" },
      { name: "messages", displayName: "Messages", category: "communication" },
      { name: "wallet", displayName: "Wallet", category: "finance" },
      { name: "music", displayName: "Music", category: "media" },
      { name: "health", displayName: "Health", category: "health" },
      { name: "notes", displayName: "Notes", category: "productivity" },
    ];
    return (
      <div className="flex flex-wrap gap-3">
        {apps.map((app) => (
          <AppIdentityTile key={app.name} app={app} />
        ))}
      </div>
    );
  },
};

export const Hero: StoryObj<typeof AppHero> = {
  render: (args) => (
    <div className="h-48 w-80">
      <AppHero {...args} />
    </div>
  ),
  args: {
    app: sampleApp,
    className: "h-full w-full rounded-md",
  },
};

export const HeroWithImage: StoryObj<typeof AppHero> = {
  render: (args) => (
    <div className="h-48 w-80">
      <AppHero {...args} />
    </div>
  ),
  args: {
    app: photoApp,
    className: "h-full w-full rounded-md",
  },
};
