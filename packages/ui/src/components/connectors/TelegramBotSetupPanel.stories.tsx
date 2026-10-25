/**
 * Storybook stories for `TelegramBotSetupPanel` under a mock app context.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { MockAppProvider } from "../../storybook/mock-providers";
import { TelegramBotSetupPanel } from "./TelegramBotSetupPanel";

const meta = {
  title: "Connectors/TelegramBotSetupPanel",
  component: TelegramBotSetupPanel,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <MockAppProvider>
        <div className="max-w-xl p-6">
          <Story />
        </div>
      </MockAppProvider>
    ),
  ],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof TelegramBotSetupPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
