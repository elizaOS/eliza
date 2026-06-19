import type { Meta, StoryObj } from "@storybook/react";
import type { AppContextValue } from "../../state/types";
import { AppContext } from "../../state/useApp";
import { CustomActionsPanel } from "./CustomActionsPanel";

const mockAppContext = new Proxy({} as AppContextValue, {
  get(_, prop) {
    if (prop === "t") {
      return (
        _key: string,
        opts?: {
          defaultValue?: string;
          actionCount?: number;
          enabledCount?: number;
          count?: number;
          name?: string;
        },
      ) => {
        if (!opts?.defaultValue) return "";
        let value = opts.defaultValue;
        for (const [k, v] of Object.entries(opts)) {
          if (k === "defaultValue") continue;
          value = value.replaceAll(`{{${k}}}`, String(v));
        }
        return value;
      };
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
  title: "CustomActions/CustomActionsPanel",
  component: CustomActionsPanel,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <AppContext.Provider value={mockAppContext}>
        <div className="flex h-[600px] bg-bg">
          <Story />
        </div>
      </AppContext.Provider>
    ),
  ],
  argTypes: {
    open: { control: "boolean" },
  },
  args: {
    open: true,
    onClose: () => {},
    onOpenEditor: () => {},
  },
} satisfies Meta<typeof CustomActionsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const Closed: Story = {
  args: {
    open: false,
  },
};
