/** Storybook stories for the Release Center shared primitives (StatusPill tones, DefinitionRow), under the shared MockAppProvider. */

import type { Meta, StoryObj } from "@storybook/react";
import { MockAppProvider } from "../../storybook/mock-providers";
import { DefinitionRow, StatusPill } from "./shared";

const meta = {
  title: "ReleaseCenter/Shared",
  component: StatusPill,
  tags: ["autodocs"],
  argTypes: {
    tone: { control: "select", options: ["neutral", "good", "warning"] },
    label: { control: "text" },
  },
  args: {
    tone: "neutral",
    label: "Pending",
  },
} satisfies Meta<typeof StatusPill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const StatusPillNeutral: Story = {
  args: {
    tone: "neutral",
    label: "Idle",
  },
};

export const StatusPillGood: Story = {
  args: {
    tone: "good",
    label: "Up to date",
  },
};

export const StatusPillWarning: Story = {
  args: {
    tone: "warning",
    label: "Update available",
  },
};

type DefinitionRowStory = StoryObj<typeof DefinitionRow>;

export const DefinitionRowDefault: DefinitionRowStory = {
  render: (args) => (
    <MockAppProvider>
      <div className="w-80 rounded-md border border-border bg-surface p-3">
        <DefinitionRow {...args} />
      </div>
    </MockAppProvider>
  ),
  args: {
    label: "Version",
    value: "1.4.2",
  },
};

export const DefinitionRowNumeric: DefinitionRowStory = {
  render: (args) => (
    <MockAppProvider>
      <div className="w-80 rounded-md border border-border bg-surface p-3">
        <DefinitionRow {...args} />
      </div>
    </MockAppProvider>
  ),
  args: {
    label: "Downloads",
    value: 12480,
  },
};

export const DefinitionRowEmptyFallback: DefinitionRowStory = {
  render: (args) => (
    <MockAppProvider>
      <div className="w-80 rounded-md border border-border bg-surface p-3">
        <DefinitionRow {...args} />
      </div>
    </MockAppProvider>
  ),
  args: {
    label: "Release notes",
    value: null,
    emptyFallback: "Not provided",
  },
};

export const DefinitionRowUnavailable: DefinitionRowStory = {
  render: (args) => (
    <MockAppProvider>
      <div className="w-80 rounded-md border border-border bg-surface p-3">
        <DefinitionRow {...args} />
      </div>
    </MockAppProvider>
  ),
  args: {
    label: "Build hash",
    value: undefined,
  },
};
