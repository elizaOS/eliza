/**
 * Storybook story for ProviderPicker — the command-palette provider chooser
 * in the Add Account dialog. Renders under a stub AppContext supplying `t`.
 */

import type { Meta, StoryObj } from "@storybook/react";
import type { AppContextValue } from "../../state/types";
import { AppContext } from "../../state/useApp";
import { ProviderPicker } from "./ProviderPicker";

const mockAppContext = new Proxy({} as AppContextValue, {
  get(_, prop) {
    if (prop === "t") {
      return (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? "";
    }
    if (prop === "uiLanguage") return "en";
    return () => {};
  },
});

const meta = {
  title: "Accounts/ProviderPicker",
  component: ProviderPicker,
  decorators: [
    (Story) => (
      <AppContext.Provider value={mockAppContext}>
        <div className="max-w-md bg-bg p-4">
          <Story />
        </div>
      </AppContext.Provider>
    ),
  ],
  args: {
    onPick: () => {},
  },
} satisfies Meta<typeof ProviderPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
