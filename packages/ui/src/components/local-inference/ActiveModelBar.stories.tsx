/** Storybook stories for ActiveModelBar — ready, loading, error, busy, and unknown-model states. */

import type { Meta, StoryObj } from "@storybook/react";
import type {
  ActiveModelState,
  InstalledModel,
} from "../../api/client-local-inference";
import { TranslationProvider } from "../../state/TranslationProvider";
import { ActiveModelBar } from "./ActiveModelBar";

const installed: InstalledModel[] = [
  {
    id: "eliza-1-2b",
    displayName: "Eliza-1 2B",
    path: "/models/eliza-1-2b.gguf",
    sizeBytes: 820_000_000,
    installedAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    source: "eliza-download",
  },
];

const readyActive: ActiveModelState = {
  modelId: "eliza-1-2b",
  loadedAt: new Date().toISOString(),
  status: "ready",
};

const meta = {
  title: "LocalInference/ActiveModelBar",
  component: ActiveModelBar,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    active: readyActive,
    installed,
    busy: false,
    onUnload: () => {},
  },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="w-80">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof ActiveModelBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};

export const Loading: Story = {
  args: {
    active: { modelId: "eliza-1-2b", loadedAt: null, status: "loading" },
  },
};

export const ErrorState: Story = {
  args: {
    active: {
      modelId: "eliza-1-2b",
      loadedAt: null,
      status: "error",
      error: "Out of memory",
    },
  },
};

export const Busy: Story = { args: { busy: true } };

/** With no installed metadata, the bar falls back to the raw model id. */
export const UnknownModel: Story = {
  args: {
    active: { modelId: "custom/local-model", loadedAt: null, status: "ready" },
    installed: [],
  },
};
