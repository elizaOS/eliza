import type { Meta, StoryObj } from "@storybook/react";
import type { AppContextValue } from "../../state/types";
import { AppContext } from "../../state/useApp";
import { TelegramBotSetupPanel } from "./TelegramBotSetupPanel";

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
  title: "Connectors/TelegramBotSetupPanel",
  component: TelegramBotSetupPanel,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <AppContext.Provider value={mockAppContext}>
        <div className="max-w-xl p-6">
          <Story />
        </div>
      </AppContext.Provider>
    ),
  ],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof TelegramBotSetupPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
