import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { MockAppProvider } from "../../storybook/mock-providers";
import {
  CloudConnectionStatus,
  CloudSourceModeToggle,
} from "./CloudSourceControls";

// ---------- CloudSourceModeToggle ----------

const toggleMeta = {
  title: "Cloud/CloudSourceControls/ModeToggle",
  component: CloudSourceModeToggle,
  tags: ["autodocs"],
  argTypes: {
    mode: { control: "radio", options: ["cloud", "own-key"] },
    cloudLabel: { control: "text" },
    ownKeyLabel: { control: "text" },
    onChange: { action: "mode-changed" },
  },
  args: {
    mode: "cloud",
    cloudLabel: "Eliza Cloud",
    ownKeyLabel: "Own API Key",
  },
} satisfies Meta<typeof CloudSourceModeToggle>;

export default toggleMeta;
type ToggleStory = StoryObj<typeof toggleMeta>;

export const CloudSelected: ToggleStory = {};

export const OwnKeySelected: ToggleStory = {
  args: { mode: "own-key" },
};

export const CustomLabels: ToggleStory = {
  args: {
    mode: "cloud",
    cloudLabel: "Managed",
    ownKeyLabel: "BYO Key",
  },
};

export const Interactive: ToggleStory = {
  render: (args) => {
    const [mode, setMode] = useState(args.mode);
    return (
      <CloudSourceModeToggle
        {...args}
        mode={mode}
        onChange={(next) => {
          setMode(next);
          args.onChange?.(next);
        }}
      />
    );
  },
};

// ---------- CloudConnectionStatus ----------

type StatusArgs = React.ComponentProps<typeof CloudConnectionStatus>;

export const ConnectionConnected: StoryObj<StatusArgs> = {
  name: "ConnectionStatus / Connected",
  render: (args) => (
    <MockAppProvider>
      <div className="w-[360px]">
        <CloudConnectionStatus {...args} />
      </div>
    </MockAppProvider>
  ),
  args: {
    connected: true,
    connectedText: "Connected to Eliza Cloud",
    disconnectedText: "Offline — check your connection",
  },
  argTypes: {
    connected: { control: "boolean" },
    connectedText: { control: "text" },
    disconnectedText: { control: "text" },
  },
};

export const ConnectionDisconnected: StoryObj<StatusArgs> = {
  name: "ConnectionStatus / Disconnected",
  render: (args) => (
    <MockAppProvider>
      <div className="w-[360px]">
        <CloudConnectionStatus {...args} />
      </div>
    </MockAppProvider>
  ),
  args: {
    connected: false,
    disconnectedText: "Offline — check your connection",
  },
};

export const ConnectionCustomLabel: StoryObj<StatusArgs> = {
  name: "ConnectionStatus / Custom Label",
  render: (args) => (
    <MockAppProvider>
      <div className="w-[360px]">
        <CloudConnectionStatus {...args} />
      </div>
    </MockAppProvider>
  ),
  args: {
    connected: true,
    connectedText: "Linked to workspace · us-east-1",
    disconnectedText: "Workspace unreachable",
  },
};
