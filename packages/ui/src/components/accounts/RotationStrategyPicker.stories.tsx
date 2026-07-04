/** Storybook stories for RotationStrategyPicker across the account rotation strategies, under a stub AppContext supplying `t`. */

import type { Meta, StoryObj } from "@storybook/react";
import type { AppContextValue } from "../../state/types";
import { AppContext } from "../../state/useApp";
import { RotationStrategyPicker } from "./RotationStrategyPicker";

const mockAppContext = new Proxy({} as AppContextValue, {
  get(_, prop) {
    if (prop === "t") {
      return (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? "";
    }
    if (prop === "uiLanguage") return "en";
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
  title: "Accounts/RotationStrategyPicker",
  component: RotationStrategyPicker,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <AppContext.Provider value={mockAppContext}>
        <div className="p-6">
          <Story />
        </div>
      </AppContext.Provider>
    ),
  ],
  argTypes: {
    providerId: { control: "text" },
    value: {
      control: "select",
      options: [
        undefined,
        "priority",
        "round-robin",
        "least-used",
        "quota-aware",
      ],
    },
    disabled: { control: "boolean" },
    onChange: { action: "changed" },
  },
  args: {
    providerId: "openai",
    value: "priority",
    disabled: false,
    onChange: () => {},
  },
} satisfies Meta<typeof RotationStrategyPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const RoundRobin: Story = {
  args: {
    providerId: "anthropic",
    value: "round-robin",
  },
};

export const LeastUsed: Story = {
  args: {
    providerId: "openrouter",
    value: "least-used",
  },
};

export const QuotaAware: Story = {
  args: {
    providerId: "groq",
    value: "quota-aware",
  },
};

export const Unset: Story = {
  args: {
    providerId: "xai",
    value: undefined,
  },
};

export const Disabled: Story = {
  args: {
    providerId: "google-genai",
    value: "priority",
    disabled: true,
  },
};
