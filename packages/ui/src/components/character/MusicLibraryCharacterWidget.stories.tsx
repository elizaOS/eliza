import type { Meta, StoryObj } from "@storybook/react";
import type { PluginInfo } from "../../api/client-types-config";
import { MusicLibraryCharacterWidget } from "./MusicLibraryCharacterWidget";

const basePluginState: PluginInfo = {
  id: "plugin-music-library",
  name: "Music Library",
  description: "Manage saved playlists and search for new music.",
  enabled: true,
  configured: true,
  envKey: null,
  category: "feature",
  source: "bundled",
  parameters: [],
  validationErrors: [],
  validationWarnings: [],
  isActive: true,
};

const meta = {
  title: "Character/MusicLibraryCharacterWidget",
  component: MusicLibraryCharacterWidget,
  tags: ["autodocs"],
  argTypes: {
    pluginId: { control: "text" },
  },
  args: {
    pluginId: "plugin-music-library",
    pluginState: basePluginState,
  },
} satisfies Meta<typeof MusicLibraryCharacterWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {};

export const PluginInstalledNotActive: Story = {
  args: {
    pluginState: {
      ...basePluginState,
      isActive: false,
    },
  },
};

export const WithoutPluginState: Story = {
  args: {
    pluginState: undefined,
  },
};

export const Disabled: Story = {
  args: {
    pluginState: {
      ...basePluginState,
      enabled: false,
      isActive: false,
    },
  },
};
