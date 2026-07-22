/** Storybook stories for AddAccountDialog across its credential-entry paths, under a stub AppContext supplying `t`. */

import type { Meta, StoryObj } from "@storybook/react";
import { seedAppValue } from "../../state/app-store";
import type { AppContextValue } from "../../state/types";
import { AppContext } from "../../state/useApp";
import { AddAccountDialog } from "./AddAccountDialog";

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
  title: "Accounts/AddAccountDialog",
  component: AddAccountDialog,
  tags: ["autodocs"],
  decorators: [
    (Story) => {
      seedAppValue(mockAppContext);
      return (
        <AppContext.Provider value={mockAppContext}>
          <div className="p-6">
            <Story />
          </div>
        </AppContext.Provider>
      );
    },
  ],
  argTypes: {
    open: { control: "boolean" },
    providerId: {
      control: "select",
      options: [
        "anthropic-subscription",
        "openai-codex",
        "gemini-cli",
        "zai-coding",
        "kimi-coding",
        "deepseek-coding",
        "anthropic-api",
        "openai-api",
        "deepseek-api",
        "zai-api",
        "moonshot-api",
        "cerebras-api",
      ],
    },
    onClose: { action: "closed" },
    onCreated: { action: "created" },
  },
  args: {
    open: true,
    providerId: "anthropic-api",
    onClose: () => {},
    onCreated: () => {},
  },
} satisfies Meta<typeof AddAccountDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConsolidatedProviderPicker: Story = {
  args: {
    providerId: undefined,
  },
};

export const ApiKey: Story = {
  args: {
    providerId: "anthropic-api",
  },
};

export const OAuthSubscription: Story = {
  args: {
    providerId: "anthropic-subscription",
  },
};

export const CodingPlanKey: Story = {
  args: {
    providerId: "zai-coding",
  },
};

export const ExternalCli: Story = {
  args: {
    providerId: "gemini-cli",
  },
};

export const UnavailableProvider: Story = {
  args: {
    providerId: "deepseek-coding",
  },
};

export const Closed: Story = {
  args: {
    open: false,
  },
};
