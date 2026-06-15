import type { Meta, StoryObj } from "@storybook/react";
import type { AppContextValue } from "../../state/types";
import { AppContext } from "../../state/useApp";
import { DefinitionRow, StatusPill } from "./shared";

const mockAppContext = new Proxy({} as AppContextValue, {
  get(_, prop) {
    if (prop === "t") {
      return (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? "Unavailable";
    }
    if (prop === "uiLanguage") return "en";
    if (prop === "companionHalfFramerateMode") return "when_saving_power";
    if (prop === "navigation") {
      return {
        scheduleAfterTabCommit: (fn: () => void) => {
          queueMicrotask(fn);
        },
      };
    }
    return () => {};
  },
});

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
    <AppContext.Provider value={mockAppContext}>
      <div className="w-80 rounded-md border border-border bg-surface p-3">
        <DefinitionRow {...args} />
      </div>
    </AppContext.Provider>
  ),
  args: {
    label: "Version",
    value: "1.4.2",
  },
};

export const DefinitionRowNumeric: DefinitionRowStory = {
  render: (args) => (
    <AppContext.Provider value={mockAppContext}>
      <div className="w-80 rounded-md border border-border bg-surface p-3">
        <DefinitionRow {...args} />
      </div>
    </AppContext.Provider>
  ),
  args: {
    label: "Downloads",
    value: 12480,
  },
};

export const DefinitionRowEmptyFallback: DefinitionRowStory = {
  render: (args) => (
    <AppContext.Provider value={mockAppContext}>
      <div className="w-80 rounded-md border border-border bg-surface p-3">
        <DefinitionRow {...args} />
      </div>
    </AppContext.Provider>
  ),
  args: {
    label: "Release notes",
    value: null,
    emptyFallback: "Not provided",
  },
};

export const DefinitionRowUnavailable: DefinitionRowStory = {
  render: (args) => (
    <AppContext.Provider value={mockAppContext}>
      <div className="w-80 rounded-md border border-border bg-surface p-3">
        <DefinitionRow {...args} />
      </div>
    </AppContext.Provider>
  ),
  args: {
    label: "Build hash",
    value: undefined,
  },
};
